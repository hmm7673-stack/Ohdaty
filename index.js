const functions = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const ExcelJS = require("exceljs");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// ---------------------------------------------------------------------------
// أداة مساعدة: التحقق من دور المستخدم الحالي
// ---------------------------------------------------------------------------
async function getUserDoc(uid) {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) throw new HttpsError("not-found", "المستخدم غير موجود");
  return { id: snap.id, ...snap.data() };
}

async function writeAuditLog({ assetId, transferId, action, performedBy, performedByName, details }) {
  await db.collection("auditLog").add({
    assetId,
    transferId,
    action,
    performedBy,
    performedByName,
    details: details || {},
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function sendNotification({ userId, title, body, type, relatedTransferId }) {
  await db.collection("notifications").add({
    userId,
    title,
    body,
    type,
    relatedTransferId: relatedTransferId || null,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// 1) طلب نقل عهدة (requestTransfer)
//    - يستدعيها: الفني صاحب الجهاز الحالي، أو الأدمن/مساعد المدير، أو مسؤول المستودع
//    - تنشئ سجل transfer بحالة "pending" وتغيّر حالة الجهاز إلى "pending_transfer"
//    - لا تغيّر currentHolderId أبداً هنا — يبقى بعهدة المُرسل حتى القبول
// ---------------------------------------------------------------------------
exports.requestTransfer = onCall(async (request) => {
  const { auth, data } = request;
  if (!auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول");

  const { assetId, toUserId, notes } = data;
  if (!assetId || !toUserId) {
    throw new HttpsError("invalid-argument", "assetId و toUserId مطلوبان");
  }

  const caller = await getUserDoc(auth.uid);
  const toUser = await getUserDoc(toUserId);

  return db.runTransaction(async (tx) => {
    const assetRef = db.collection("assets").doc(assetId);
    const assetSnap = await tx.get(assetRef);
    if (!assetSnap.exists) throw new HttpsError("not-found", "الجهاز غير موجود");
    const asset = assetSnap.data();

    if (asset.status === "pending_transfer") {
      throw new HttpsError("failed-precondition", "الجهاز لديه عملية نقل معلّقة بالفعل");
    }

    const isOwnerTechnician = caller.role === "technician" && asset.currentHolderId === auth.uid;
    const isPrivileged = ["admin", "assistant_manager", "warehouse_manager"].includes(caller.role);

    if (!isOwnerTechnician && !isPrivileged) {
      throw new HttpsError("permission-denied", "لا تملك صلاحية نقل هذا الجهاز");
    }

    const transferRef = db.collection("transfers").doc();
    tx.set(transferRef, {
      transferId: transferRef.id,
      assetId,
      assetName: asset.name,
      fromUserId: asset.currentHolderId || null,
      fromUserName: asset.currentHolderName || "المستودع",
      toUserId,
      toUserName: toUser.fullName,
      status: "pending",
      initiatedBy: auth.uid,
      initiatorRole: caller.role,
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      respondedAt: null,
      qrScanned: false,
      gpsLocation: null,
      conditionImageUrl: null,
      notes: notes || "",
    });

    tx.update(assetRef, {
      status: "pending_transfer",
      pendingTransferId: transferRef.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { transferId: transferRef.id };
  }).then(async (result) => {
    await writeAuditLog({
      assetId,
      transferId: result.transferId,
      action: "transfer_requested",
      performedBy: auth.uid,
      performedByName: caller.fullName,
      details: { toUserId, toUserName: toUser.fullName },
    });

    await sendNotification({
      userId: toUserId,
      title: "طلب استلام عهدة جديد",
      body: `لديك طلب استلام جهاز جديد من ${caller.fullName}`,
      type: "transfer_request",
      relatedTransferId: result.transferId,
    });

    return result;
  });
});

// ---------------------------------------------------------------------------
// 2) قبول النقل (acceptTransfer)
//    - فقط toUserId نفسه يقدر يستدعيها (هذا يضمن أن الأدمن ما يقدر يفرض النقل بدون
//      موافقة الفني حتى لو هو اللي بدأ الطلب)
//    - تُحدّث currentHolderId على الجهاز + تسجّل GPS وصورة الحالة و QR
// ---------------------------------------------------------------------------
exports.acceptTransfer = onCall(async (request) => {
  const { auth, data } = request;
  if (!auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول");

  const { transferId, qrScanned, gpsLocation, conditionImageUrl } = data;
  if (!transferId) throw new HttpsError("invalid-argument", "transferId مطلوب");

  return db.runTransaction(async (tx) => {
    const transferRef = db.collection("transfers").doc(transferId);
    const transferSnap = await tx.get(transferRef);
    if (!transferSnap.exists) throw new HttpsError("not-found", "طلب النقل غير موجود");
    const transfer = transferSnap.data();

    if (transfer.status !== "pending") {
      throw new HttpsError("failed-precondition", "هذا الطلب لم يعد قيد الانتظار");
    }
    if (transfer.toUserId !== auth.uid) {
      throw new HttpsError("permission-denied", "فقط المستلم المحدد يمكنه قبول هذه العهدة");
    }

    const assetRef = db.collection("assets").doc(transfer.assetId);
    const assetSnap = await tx.get(assetRef);
    const asset = assetSnap.data();

    const toUser = await getUserDoc(auth.uid);

    tx.update(assetRef, {
      currentHolderId: auth.uid,
      currentHolderName: toUser.fullName,
      status: "in_custody",
      pendingTransferId: null,
      conditionImageUrl: conditionImageUrl || asset.conditionImageUrl || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.update(transferRef, {
      status: "accepted",
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      qrScanned: !!qrScanned,
      gpsLocation: gpsLocation || null,
      conditionImageUrl: conditionImageUrl || null,
    });

    return { transfer, toUserName: toUser.fullName };
  }).then(async ({ transfer, toUserName }) => {
    await writeAuditLog({
      assetId: transfer.assetId,
      transferId,
      action: "transfer_accepted",
      performedBy: auth.uid,
      performedByName: toUserName,
      details: { gpsLocation, qrScanned },
    });

    if (transfer.fromUserId) {
      await sendNotification({
        userId: transfer.fromUserId,
        title: "تم استلام العهدة",
        body: `${toUserName} استلم جهاز ${transfer.assetName}`,
        type: "transfer_accepted",
        relatedTransferId: transferId,
      });
    }

    return { success: true };
  });
});

// ---------------------------------------------------------------------------
// 3) رفض النقل (rejectTransfer) — يرجّع الجهاز لحالته الأصلية عند المُرسل
// ---------------------------------------------------------------------------
exports.rejectTransfer = onCall(async (request) => {
  const { auth, data } = request;
  if (!auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول");

  const { transferId, reason } = data;

  return db.runTransaction(async (tx) => {
    const transferRef = db.collection("transfers").doc(transferId);
    const transferSnap = await tx.get(transferRef);
    if (!transferSnap.exists) throw new HttpsError("not-found", "الطلب غير موجود");
    const transfer = transferSnap.data();

    if (transfer.toUserId !== auth.uid) {
      throw new HttpsError("permission-denied", "فقط المستلم المحدد يمكنه رفض الطلب");
    }
    if (transfer.status !== "pending") {
      throw new HttpsError("failed-precondition", "هذا الطلب لم يعد قيد الانتظار");
    }

    const assetRef = db.collection("assets").doc(transfer.assetId);
    tx.update(assetRef, {
      status: transfer.fromUserId ? "in_custody" : "in_warehouse",
      pendingTransferId: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.update(transferRef, {
      status: "rejected",
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      notes: (transfer.notes || "") + `\nسبب الرفض: ${reason || "غير محدد"}`,
    });

    return transfer;
  }).then(async (transfer) => {
    await writeAuditLog({
      assetId: transfer.assetId,
      transferId,
      action: "transfer_rejected",
      performedBy: auth.uid,
      performedByName: transfer.toUserName,
      details: { reason },
    });

    await sendNotification({
      userId: transfer.initiatedBy,
      title: "تم رفض طلب النقل",
      body: `${transfer.toUserName} رفض استلام جهاز ${transfer.assetName}`,
      type: "transfer_rejected",
      relatedTransferId: transferId,
    });

    return { success: true };
  });
});

// ---------------------------------------------------------------------------
// 4) إشعارات Push تلقائية (FCM) عند إنشاء أي إشعار جديد بالـ Firestore
// ---------------------------------------------------------------------------
exports.onNotificationCreated = onDocumentCreated("notifications/{notifId}", async (event) => {
  const notif = event.data.data();
  const userSnap = await db.collection("users").doc(notif.userId).get();
  const fcmToken = userSnap.data()?.fcmToken;
  if (!fcmToken) return;

  await messaging.send({
    token: fcmToken,
    notification: { title: notif.title, body: notif.body },
    data: { type: notif.type, relatedTransferId: notif.relatedTransferId || "" },
  });

  // نقطة ربط واتساب: استبدل هذا بمزود WhatsApp Business API الفعلي (مثال: Twilio / 360dialog)
  // await sendWhatsAppMessage(userSnap.data().phone, notif.body);
});

// ---------------------------------------------------------------------------
// 5) إنشاء مستخدم جديد من طرف الأدمن / مساعد المدير (createUserByAdmin)
//    - يستخدم Admin SDK لإنشاء الحساب في Firebase Auth دون التأثير على جلسة
//      المسؤول الحالي (وهذا غير ممكن بأمان لو تم من طرف العميل مباشرة)
//    - ينشئ أيضاً وثيقة المستخدم في Firestore بنفس الـ uid
// ---------------------------------------------------------------------------
exports.createUserByAdmin = onCall(async (request) => {
  const { auth, data } = request;
  if (!auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول");

  const caller = await getUserDoc(auth.uid);
  if (!["admin", "assistant_manager"].includes(caller.role)) {
    throw new HttpsError("permission-denied", "فقط الأدمن أو مساعد المدير يمكنه إنشاء حسابات");
  }

  const { fullName, email, password, phone, role } = data;
  if (!fullName || !email || !password || !role) {
    throw new HttpsError("invalid-argument", "جميع الحقول الأساسية مطلوبة");
  }
  const allowedRoles = ["admin", "assistant_manager", "warehouse_manager", "technician"];
  if (!allowedRoles.includes(role)) {
    throw new HttpsError("invalid-argument", "دور غير صالح");
  }

  const userRecord = await admin.auth().createUser({
    email,
    password,
    displayName: fullName,
    phoneNumber: phone ? phone : undefined,
  });

  await db.collection("users").doc(userRecord.uid).set({
    fullName,
    email,
    phone: phone || "",
    role,
    preferredLanguage: "ar",
    active: true,
    createdBy: auth.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    assetId: null,
    transferId: null,
    action: "user_created",
    performedBy: auth.uid,
    performedByName: caller.fullName,
    details: { newUserId: userRecord.uid, role },
  });

  return { uid: userRecord.uid };
});

// ---------------------------------------------------------------------------
// 6) إضافة جهاز جديد للمخزون (createAsset) — للأدمن / مساعد المدير / مسؤول المستودع
// ---------------------------------------------------------------------------
exports.createAsset = onCall(async (request) => {
  const { auth, data } = request;
  if (!auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول");

  const caller = await getUserDoc(auth.uid);
  if (!["admin", "assistant_manager", "warehouse_manager"].includes(caller.role)) {
    throw new HttpsError("permission-denied", "لا تملك صلاحية إضافة أجهزة");
  }

  const { name, category, serialNumber, imageUrl } = data;
  if (!name || !serialNumber) {
    throw new HttpsError("invalid-argument", "اسم الجهاز والرقم التسلسلي مطلوبان");
  }

  const assetRef = db.collection("assets").doc();
  await assetRef.set({
    assetId: assetRef.id,
    name,
    category: category || "",
    serialNumber,
    qrCodeValue: assetRef.id,
    imageUrl: imageUrl || null,
    conditionImageUrl: null,
    status: "in_warehouse",
    currentHolderId: null,
    currentHolderName: null,
    pendingTransferId: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    assetId: assetRef.id,
    transferId: null,
    action: "asset_created",
    performedBy: auth.uid,
    performedByName: caller.fullName,
    details: { name, serialNumber },
  });

  return { assetId: assetRef.id };
});

// ---------------------------------------------------------------------------
// 7) تصدير تقرير Excel لحركة الأجهزة (للأدمن ومساعد المدير فقط)
// ---------------------------------------------------------------------------
exports.exportAssetsReport = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول");
  const caller = await getUserDoc(auth.uid);
  if (!["admin", "assistant_manager"].includes(caller.role)) {
    throw new HttpsError("permission-denied", "هذا التقرير للأدمن فقط");
  }

  const transfersSnap = await db.collection("transfers").orderBy("requestedAt", "desc").get();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("سجل حركة الأجهزة");
  sheet.columns = [
    { header: "اسم الجهاز", key: "assetName", width: 25 },
    { header: "من", key: "fromUserName", width: 20 },
    { header: "إلى", key: "toUserName", width: 20 },
    { header: "الحالة", key: "status", width: 15 },
    { header: "تاريخ الطلب", key: "requestedAt", width: 20 },
    { header: "تاريخ الرد", key: "respondedAt", width: 20 },
  ];

  transfersSnap.forEach((doc) => {
    const t = doc.data();
    sheet.addRow({
      assetName: t.assetName,
      fromUserName: t.fromUserName,
      toUserName: t.toUserName,
      status: t.status,
      requestedAt: t.requestedAt ? t.requestedAt.toDate().toLocaleString("ar-SA") : "",
      respondedAt: t.respondedAt ? t.respondedAt.toDate().toLocaleString("ar-SA") : "",
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return { fileBase64: buffer.toString("base64"), fileName: "ohdaty_report.xlsx" };
});
