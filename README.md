# عهدتي | Ohdaty — نظام إدارة عهد الأجهزة والمعدات

مشروع Firebase: `ohdaty` | التقنية المقترحة: **Flutter** (يعمل من كود واحد على Android / iOS / Windows) + **Firebase** (Auth, Firestore, Storage, Cloud Functions, FCM)

---

## 1. لماذا Flutter؟

طلبك يشمل دعم **Galaxy (Android) + iPhone (iOS) + Windows**. الخيار الوحيد اللي يعطيك كود واحد يشتغل فعلياً على الثلاثة بجودة native هو **Flutter** (Flutter Desktop يدعم Windows رسمياً). React Native ما يدعم Windows بشكل رسمي، وElectron للويب فقط. لذلك التوصية: **Flutter + FlutterFire (مكتبات Firebase الرسمية لـ Flutter)**.

---

## 2. هيكلة قاعدة البيانات (Cloud Firestore)

Firestore قاعدة NoSQL (Collections/Documents) — هذا هو التصميم:

### Collection: `users`
```
users/{uid}
{
  uid: string,
  fullName: string,
  email: string,
  phone: string,
  role: "admin" | "assistant_manager" | "warehouse_manager" | "technician",
  department: string,
  preferredLanguage: "ar" | "en",
  fcmToken: string,          // لإرسال الإشعارات
  active: boolean,
  createdBy: string,          // uid الأدمن اللي أنشأ الحساب
  createdAt: timestamp
}
```

### Collection: `assets` (الأجهزة/المعدات)
```
assets/{assetId}
{
  assetId: string,
  name: string,                 // "كاميرا حرارية"
  category: string,
  serialNumber: string,
  qrCodeValue: string,          // نفس assetId يُطبع كـ QR
  imageUrl: string,              // صورة الجهاز الأصلية
  conditionImageUrl: string,     // آخر صورة حالة مسجّلة
  status: "in_warehouse" | "in_custody" | "pending_transfer" | "maintenance",
  currentHolderId: string,       // uid الفني الحالي أو null إذا بالمستودع
  currentHolderName: string,     // denormalized لسهولة العرض
  pendingTransferId: string,     // مرجع للنقل الجاري إن وجد
  createdAt: timestamp,
  updatedAt: timestamp
}
```

### Collection: `transfers` (عمليات النقل)
```
transfers/{transferId}
{
  transferId: string,
  assetId: string,
  assetName: string,
  fromUserId: string,           // null إذا من المستودع
  fromUserName: string,
  toUserId: string,
  toUserName: string,
  status: "pending" | "accepted" | "rejected" | "cancelled",
  initiatedBy: string,           // uid منشئ الطلب (فني/أدمن/مسؤول مستودع)
  initiatorRole: string,
  requestedAt: timestamp,
  respondedAt: timestamp,
  qrScanned: boolean,
  gpsLocation: { lat: number, lng: number } | null,
  conditionImageUrl: string,
  notes: string
}
```

### Collection: `auditLog` (سجل الأدمن الكامل)
```
auditLog/{logId}
{
  assetId: string,
  transferId: string,
  action: "transfer_requested" | "transfer_accepted" | "transfer_rejected" | "transfer_cancelled" | "asset_created",
  performedBy: string,
  performedByName: string,
  timestamp: timestamp,
  details: map
}
```

### Collection: `notifications`
```
notifications/{notifId}
{
  userId: string,               // المستلم
  title: string,
  body: string,
  type: "transfer_request" | "transfer_accepted" | "transfer_rejected",
  relatedTransferId: string,
  read: boolean,
  createdAt: timestamp
}
```

---

## 3. العلاقات (Relations) بين الجداول

- **users → assets** (1:N): كل جهاز فيه `currentHolderId` يشاور على مستخدم واحد. بالمقابل، تقدر تجيب كل أجهزة فني معيّن بـ query:
  `where('currentHolderId', '==', uid)`
- **assets → transfers** (1:N): كل جهاز له سجل تاريخي من عمليات النقل، تجيبه بـ:
  `where('assetId', '==', assetId).orderBy('requestedAt', 'desc')`
- **transfers → users** (N:1 مرتين): `fromUserId` و`toUserId` كل وحدة تشاور على مستخدم.
- **transfers → auditLog** (1:1 لكل حدث): كل تغيير حالة بالـ transfer يولّد سطر بالـ auditLog تلقائياً من Cloud Function (مو من العميل — هذا مهم للأمان، يعني الفني ما يقدر يتلاعب بالسجل).
- **transfers → notifications** (1:N): كل transfer ينشئ إشعار للطرف التاني تلقائياً.

**قاعدة الأمان الجوهرية:** الفني **لا يكتب مباشرة** على `assets.currentHolderId` أو `auditLog` — كل هذا يصير فقط من داخل Cloud Functions (Server-side) بعد التحقق، عشان محد يقدر يزوّر عهدة جهاز من طرف العميل (Client).

---

## 4. مصفوفة الصلاحيات (RBAC)

| الدور | عرض كل الأجهزة | إنشاء يوزرات | بدء نقل جهاز | نقل بدون موافقة الفني | قبول/رفض عهدة |
|---|---|---|---|---|---|
| **admin** | ✅ الكل | ✅ | ✅ لأي جهاز | ❌ (يحتاج موافقة الفني دايماً) | ✅ |
| **assistant_manager** | ✅ الكل | ✅ | ✅ لأي جهاز | ❌ | ✅ |
| **warehouse_manager** | ✅ (المستودع + المعلّقة) | ❌ | ✅ تسليم/استلام من وإلى المستودع | ❌ | ✅ |
| **technician** | ⚠️ عهدته فقط | ❌ | ✅ لأجهزته فقط | ❌ | ✅ |

> ملاحظة مهمة حسب طلبك: حتى لما الأدمن أو مساعد المدير يبدأ عملية نقل جهاز لفني، الجهاز **يبقى بحالة "بانتظار القبول"** ولازم الفني نفسه يضغط "قبول واستلام" — هذا محقق تلقائياً لأن دالة `acceptTransfer` هي الوحيدة اللي تغيّر `currentHolderId`، وما تسمح إلا للـ `toUserId` نفسه يستدعيها.

---

## الملفات المرفقة
1. `firestore.rules` — قواعد الأمان الكاملة حسب الأدوار
2. `functions/index.js` — Cloud Functions (طلب النقل، القبول، الرفض، الإشعارات، تصدير التقارير)
3. `functions/package.json`
4. `flutter_models/models.dart` — نماذج البيانات + خدمة النقل (Transfer Service) بلغة Dart
