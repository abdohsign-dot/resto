'use strict';
/* ============================================================
   Restaurant ordering app — core: state, api, offline queue, poll
   ============================================================ */

// ---------- tiny helpers ----------
function $(s) { return document.querySelector(s); }
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function money(v) { return Number(v || 0).toFixed(2) + ' ' + (S.data && S.data.currency ? S.data.currency : 'MAD'); }
function hhmm(ts) {
  var d = new Date(ts * 1000);
  var dd = ('0' + d.getDate()).slice(-2);
  var mm = ('0' + (d.getMonth() + 1)).slice(-2);
  var yyyy = d.getFullYear();
  var hh = ('0' + d.getHours()).slice(-2);
  var mi = ('0' + d.getMinutes()).slice(-2);
  return dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi;
}
function ageMin(ts) { return Math.max(0, Math.round((Date.now() / 1000 - S.skew - ts) / 60)); }
function ageLabel(ts) {
  var m = ageMin(ts), h = Math.floor(m / 60), r = m % 60;
  if (S.lang === 'fr') return m < 60 ? m + ' min' : h + ' h ' + r + ' min';
  if (S.lang === 'ar') return m < 60 ? m + ' د' : h + ' س ' + r + ' د';
  return m < 60 ? m + 'm' : h + 'h' + r + 'm';
}
function ageClass(ts) {
  var m = ageMin(ts);
  var amber = Number(S.data && S.data.settings && S.data.settings.ticket_amber_minutes != null
    ? S.data.settings.ticket_amber_minutes : 5);
  var red = Number(S.data && S.data.settings && S.data.settings.ticket_red_minutes != null
    ? S.data.settings.ticket_red_minutes : 10);
  return m >= red ? 'late' : (m >= amber ? 'warn' : '');
}
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}
function openOrders(list) {
  return (list || []).filter(function (o) {
    return o.status === 'sent' || o.status === 'preparing' || o.status === 'ready';
  });
}
function parseTables(staffTables) {
  try { var a = JSON.parse(staffTables || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}

// ---------- persistent state ----------
var S = {
  role: null, waiterId: null, data: null, rev: -1, skew: 0, online: true,
  branchId: 1,
  tableNo: null, search: '', sectionFilter: 0, adminTab: 'sections',
  adminItemFilter: 0, adminSearch: '', cart: {}, queue: [], seen: {}, pollT: null,
  adminPin: null, lang: 'fr',
  catalogProducts: [], catalogGroups: [], catalogLoadedFor: null, adminProductId: null,
  kitchenStation: null, kitchenStationFilter: null
};

var I18N = {
  fr: {
    offline: 'Hors ligne - les commandes sont sauvegardées sur cet appareil et seront envoyées au retour de la connexion.',
    waitOnline: 'action(s) de commande en attente - envoi automatique au retour de la connexion',
    language: 'Langue', pageTitle: 'Commandes du restaurant',
    roleHintMore: 'Utilisez une tablette par poste : les serveurs prennent les commandes, la cuisine reçoit les tickets en temps réel et l’administration gère le menu, le personnel et les paramètres.',
    waiterRole: 'Serveur', kitchenRole: 'Cuisine', adminRole: 'Administration',
    whoUses: 'Qui utilise cette tablette ?', roleHint: 'Le choix est mémorisé sur cet appareil.',
    roles: 'Rôles', waiterSignin: 'Connexion du serveur', myTables: 'Mes tables', home: 'Accueil', viewSectionItems: 'Voir les articles',
    table: 'Table', free: 'Libre', ready: 'Prêt - à servir !', orderSent: 'Commande envoyée',
    cooking: 'En préparation', noTables: 'Aucune table ne vous est attribuée.',
    noWaiters: 'Aucun serveur pour le moment.',
    noOpen: 'Aucun ticket ouvert pour cette table.', tickets: 'Tickets',
    all: 'Tout', menu: 'Menu', searchMenu: 'Rechercher dans le menu...', noDishes: 'Aucun plat trouvé.',
    review: 'Voir la commande', reviewOrder: 'Vérifier la commande', keepEditing: 'Continuer les modifications',
    sendKitchen: 'Envoyer en cuisine', print: 'Imprimer', served: 'Servi', cancel: 'Annuler',
    ticket: 'Ticket', noteKitchen: 'Note pour la cuisine (allergie, timing...)',
    noteOptional: 'facultatif', new: 'Nouvelles', preparing: 'En préparation',
    sent: 'Envoyée', cancelled: 'Annulée', nothingHere: 'Rien ici', startCooking: 'Commencer la préparation',
    allReady: 'Tout est prêt', noOrders: 'Aucune commande pour le moment.',
    openTickets: 'Tickets ouverts et commandes des dernières 24 heures.',
    connecting: 'Connexion au serveur…', waiterHint: 'Aucun serveur pour le moment. Ajoutez-en dans Administration.',
    switchWaiter: 'Changer de serveur', ticketCount: 'ticket', ticketPlural: 'tickets', itemCount: 'article(s)',
    noteLabel: 'Note', noteItem: 'Note pour cet article', itemNotePlaceholder: 'ex. sans oignons, bien cuit',
    back: 'Retour', save: 'Enregistrer', optional: 'facultatif', send: 'Envoyer en cuisine',
    cancelTicketTitle: 'Annuler le ticket n°', cancelReason: 'Motif (visible dans le journal de cuisine)',
    cancelReasonPlaceholder: 'ex. le client a changé d’avis', keepTicket: 'Garder le ticket',
    cancelTicket: 'Annuler le ticket', keepItem: 'Garder l’article', cancelItem: 'Annuler l’article',
    item: 'article', alreadyReady: 'Déjà prêt', itemReady: 'Article prêt ✓', itemCooking: 'Préparation en cours…',
    cookingStarted: 'Préparation commencée', orderReady: 'Tout est prêt ✓', ticketServed: 'Ticket servi ✓',
    ticketSent: 'envoyé en cuisine ✓', sendFailed: 'Impossible d’envoyer la commande : ',
    offlineSavedOrder: 'Hors ligne - commande enregistrée et envoi automatique à la reconnexion.',
    actionFailed: 'Action impossible : ', offlineSavedAction: 'Hors ligne - action enregistrée et envoi automatique à la reconnexion.',
    backOnline: 'Connexion rétablie', rejected: 'Requête refusée : ',
    sections: 'Rubriques', menuTab: 'Menu', editSection: 'Modifier la rubrique', waiters: 'Serveurs', orders: 'Commandes', settings: 'Paramètres',
    admin: 'Administration', restricted: 'Accès réservé', enterPin: 'Saisir le code administrateur',
    unlock: 'Déverrouiller', defaultPin: 'Code par défaut : 1234. Modifiez-le dans Paramètres après connexion.',
    enterPinToast: 'Saisissez le code', adminUnlocked: 'Administration déverrouillée',
    wrongPin: 'Code incorrect', serverUnavailable: 'Serveur inaccessible : ',
    newSection: 'Nouvelle rubrique', renameSection: 'Renommer la rubrique', sectionPlaceholder: 'ex. Salades',
    noSections: 'Aucune rubrique. Ajoutez votre première rubrique.', itemSingular: 'article', itemsPlural: 'articles',
    active: 'Actif', hidden: 'Masqué', hide: 'Masquer', show: 'Afficher', delete: 'Supprimer',
    deleteQuestion: 'Supprimer «', hasItems: 'Cette rubrique contient encore ', moveOrDelete: ' article(s). Déplacez-les ou supprimez-les d’abord.',
    cannotUndo: 'Cette action est irréversible.', keep: 'Conserver', deleted: 'Supprimé',
    allSections: 'Toutes les rubriques', searchItems: 'Rechercher des articles…', addItem: '＋ Article',
    noItemsMatch: 'Aucun article trouvé.', editItem: 'Modifier l’article', newItem: 'Nouvel article',
    name: 'Nom', price: 'Prix', section: 'Rubrique', description: 'Description (facultative)',
    itemNamePlaceholder: 'ex. Salade César', descriptionPlaceholder: 'Courte description affichée aux serveurs',
    activeOnWaiter: 'Actif (visible sur les tablettes des serveurs)', pastTicketsKept: 'Les anciens tickets conservent le nom et le prix de l’article.',
    noTablesAssigned: 'Aucune table', offDuty: 'Absent', onDuty: 'En service', newWaiter: 'Nouveau serveur',
    tableRanges: 'Les tables acceptent des plages, ex. 1-8, 12, 15-17. Chaque serveur ne voit que ses tables.',
    noWaitersYet: 'Aucun serveur pour le moment.', editWaiter: 'Modifier le serveur',
    waiterNamePlaceholder: 'Nom du serveur', tablesLabel: 'Tables (plages autorisées : 1-8, 12, 15-17)',
    tablesPlaceholder: 'ex. 1-8, 12', onDutyLabel: 'En service', willSeeTables: 'Tables attribuées :',
    noTablesAssignedYet: 'Aucune table attribuée.', pastTicketsStaffKept: 'Les anciens tickets du serveur sont conservés avec son nom.',
    orderHistory: 'Tickets ouverts et commandes des dernières 24 heures.', tableLabel: 'Table',
    restaurant: 'Restaurant', printedName: 'Nom (imprimé sur les tickets)', currency: 'Devise',
    ticketPrinter: 'Imprimante à tickets', printerHelp: 'Imprimante thermique ESC/POS sur le réseau local (la plupart des imprimantes de cuisine, port 9100). Laissez l’adresse IP vide pour la désactiver ; les tickets restent imprimables depuis les tablettes via le navigateur.',
    printerIp: 'Adresse IP de l’imprimante', printerPort: 'Port de l’imprimante',
    autoPrint: 'Imprimer automatiquement à la réception d’un ticket en cuisine',
    security: 'Sécurité', newAdminPin: 'Nouveau code administrateur (4 chiffres minimum)',
    newPinPlaceholder: 'Nouveau code', changePin: 'Modifier le code', data: 'Données',
    localDataHelp: 'Toutes les données sont enregistrées localement dans data/restaurant.db, à côté de server.py.',
    serverAddress: 'Adresse du serveur sur ce réseau :', exportData: '⬇ Exporter toutes les données (JSON)',
    settingsSaved: 'Paramètres enregistrés', pinMin: 'Le code doit contenir au moins 4 chiffres.',
    pinChanged: 'Code modifié', exportDownloaded: 'Export téléchargé', exportFailed: 'Échec de l’export : ',
    needConnection: 'Connexion au serveur requise', nameRequired: 'Le nom est obligatoire.',
    validPrice: 'Saisissez un prix valide.', saved: 'Enregistré',
    orderItems: 'article(s)', notePrefix: 'Note : ', statusConnection: 'État de la connexion',
    outOfStock: '86 - article indisponible', clear: 'Effacer',
    deleteSuffix: '» ?', saveSettings: 'Enregistrer les paramètres',
    noTablesShort: 'Aucune table', serverAddressLabel: 'Adresse du serveur sur ce réseau :',
    questionSuffix: ' ?', restaurantName: 'Commandes du restaurant', printerIpPlaceholder: 'ex. 192.168.1.50',
    branch: 'Établissement', reservations: 'Réservations', newReservation: 'Nouvelle réservation',
    guestName: 'Nom du client', contact: 'Téléphone / contact', reservationTime: 'Date et heure',
    partySize: 'Nombre de personnes', reservationNote: 'Note', booked: 'Réservée', seated: 'Installée',
    noShow: 'Absent', createReservation: 'Ajouter une réservation', sales: 'Ventes',
    payment: 'Paiement', recordPayment: 'Enregistrer un paiement', amount: 'Montant',
    method: 'Mode de paiement', cash: 'Espèces', card: 'Carte', other: 'Autre',
    splitItems: 'Répartir par articles', paid: 'Payé', balance: 'À payer', requestBill: 'Demander l’addition',
    analyticsPeriod: 'Période', topItems: 'Articles les plus vendus', revenue: 'Recettes encaissées',
    newBranch: 'Nouvel établissement', copyMenu: 'Copier le menu et le personnel actuels',
    stock: 'Stock restant (vide = non suivi)', image: 'Image du plat', modifiers: 'Options (une par ligne : nom:prix)',
    noReservations: 'Aucune réservation à venir.', branchCreated: 'Établissement créé',
    inventory: 'Stock', noSales: 'Aucune vente enregistrée pour cette période.',
    refund: 'Rembourser', refundAmount: 'Montant à rembourser', paymentRefunded: 'Remboursement enregistré',
    staffPin: 'Code PIN (laisser vide = sans code)', staffRole: 'Rôle', kitchenStation: 'Poste cuisine',
    allStations: 'Tous les postes', enterStaffPin: 'Entrez votre code', waiterRoleLabel: 'Serveur',
    kitchenRoleLabel: 'Cuisine', stationPick: 'Choisir votre poste'
  },
  ar: {
    offline: 'غير متصل - يتم حفظ الطلبات على هذا الجهاز',
    waitOnline: 'طلب قيد الانتظار - سيتم الإرسال تلقائيا',
    language: 'اللغة', roleHintMore: 'استخدم جهازا لوحيا لكل محطة: يستقبل النادلون الطلبات، ويرى المطبخ التذاكر فوريا، وتدير الإدارة قائمة الطعام والموظفين والإعدادات.',
    waiterRole: 'النادل', kitchenRole: 'المطبخ', adminRole: 'الإدارة',
    whoUses: 'من يستخدم هذا الجهاز اللوحي؟', roleHint: 'تم تذكر الاختيار على هذا الجهاز.',
    roles: 'الأدوار', waiterSignin: 'تسجيل دخول النادل', myTables: 'طاولاتي', home: 'الرئيسية', viewSectionItems: 'عرض العناصر',
    table: 'طاولة', free: 'فارغة', ready: 'جاهز - للتقديم!', orderSent: 'تم إرسال الطلب',
    cooking: 'قيد التحضير', noTables: 'لا توجد طاولات مخصصة لك.',
    noWaiters: 'لا يوجد نادلون حاليا.',
    noOpen: 'لا توجد تذاكر مفتوحة لهذه الطاولة.', tickets: 'التذاكر',
    all: 'الكل', menu: 'قائمة الطعام', searchMenu: 'البحث في القائمة...', noDishes: 'لا توجد أطباق.',
    review: 'مراجعة الطلب', reviewOrder: 'مراجعة الطلب', keepEditing: 'متابعة',
    sendKitchen: 'إرسال للمطبخ', print: 'طباعة', served: 'تم التقديم', cancel: 'إلغاء',
    ticket: 'تذكرة', noteKitchen: 'ملاحظة للمطبخ (حساسية، توقيت...)',
    noteOptional: 'اختياري', new: 'جديد', preparing: 'قيد التحضير',
    sent: 'مرسل', cancelled: 'ملغى', nothingHere: 'لا يوجد شيء هنا', startCooking: 'بدء التحضير',
    allReady: 'كل شيء جاهز', noOrders: 'لا توجد طلبات حاليا.',
    openTickets: 'التذاكر المفتوحة والطلبات خلال آخر 24 ساعة.',
    connecting: 'جارٍ الاتصال بالخادم…', waiterHint: 'لا يوجد نادل حاليا. أضف النادلين من الإدارة.',
    switchWaiter: 'تغيير النادل', ticketCount: 'تذكرة', ticketPlural: 'تذاكر', itemCount: 'عنصر/عناصر',
    noteLabel: 'ملاحظة', noteItem: 'ملاحظة لهذا العنصر', itemNotePlaceholder: 'مثال: بدون بصل، مطهو جيدا',
    back: 'رجوع', save: 'حفظ', optional: 'اختياري', send: 'إرسال للمطبخ',
    cancelTicketTitle: 'إلغاء التذكرة رقم ', cancelReason: 'السبب (يظهر في سجل المطبخ)',
    cancelReasonPlaceholder: 'مثال: غيّر العميل رأيه', keepTicket: 'الاحتفاظ بالتذكرة',
    cancelTicket: 'إلغاء التذكرة', keepItem: 'الاحتفاظ بالعنصر', cancelItem: 'إلغاء العنصر',
    item: 'عنصر', alreadyReady: 'جاهز بالفعل', itemReady: 'العنصر جاهز ✓', itemCooking: 'جارٍ تحضير العنصر…',
    cookingStarted: 'بدأ التحضير', orderReady: 'كل شيء جاهز ✓', ticketServed: 'تم تقديم التذكرة ✓',
    ticketSent: 'تم الإرسال إلى المطبخ ✓', sendFailed: 'تعذر إرسال الطلب: ',
    offlineSavedOrder: 'غير متصل - تم حفظ الطلب وسيُرسل تلقائيا عند عودة الاتصال.',
    actionFailed: 'تعذر تنفيذ الإجراء: ', offlineSavedAction: 'غير متصل - تم حفظ الإجراء وسيُرسل تلقائيا عند عودة الاتصال.',
    backOnline: 'عاد الاتصال', rejected: 'تم رفض الطلب: ',
    sections: 'الأقسام', menuTab: 'قائمة الطعام', editSection: 'تعديل القسم', waiters: 'النادلون', orders: 'الطلبات', settings: 'الإعدادات',
    admin: 'الإدارة', restricted: 'للمصرح لهم فقط', enterPin: 'أدخل رمز الإدارة',
    unlock: 'فتح', defaultPin: 'الرمز الافتراضي 1234 - غيّره من الإعدادات بعد تسجيل الدخول.',
    enterPinToast: 'أدخل الرمز', adminUnlocked: 'تم فتح الإدارة',
    wrongPin: 'الرمز غير صحيح', serverUnavailable: 'تعذر الاتصال بالخادم: ',
    newSection: 'قسم جديد', renameSection: 'إعادة تسمية القسم', sectionPlaceholder: 'مثال: السلطات',
    noSections: 'لا توجد أقسام. أضف أول قسم.', itemSingular: 'عنصر', itemsPlural: 'عناصر',
    active: 'نشط', hidden: 'مخفي', hide: 'إخفاء', show: 'إظهار', delete: 'حذف',
    deleteQuestion: 'حذف «', hasItems: 'لا يزال هذا القسم يحتوي على ', moveOrDelete: ' عنصر/عناصر. انقلها أو احذفها أولا.',
    cannotUndo: 'لا يمكن التراجع عن هذا الإجراء.', keep: 'إبقاء', deleted: 'تم الحذف',
    allSections: 'كل الأقسام', searchItems: 'البحث عن عناصر…', addItem: '＋ عنصر',
    noItemsMatch: 'لا توجد عناصر مطابقة.', editItem: 'تعديل العنصر', newItem: 'عنصر جديد',
    name: 'الاسم', price: 'السعر', section: 'القسم', description: 'الوصف (اختياري)',
    itemNamePlaceholder: 'مثال: سلطة سيزر', descriptionPlaceholder: 'وصف قصير يظهر للنادلين',
    activeOnWaiter: 'نشط (يظهر على أجهزة النادلين)', pastTicketsKept: 'تحتفظ التذاكر السابقة بنسخة من اسم العنصر وسعره.',
    noTables: 'لا توجد طاولات', offDuty: 'خارج الخدمة', onDuty: 'في الخدمة', newWaiter: 'نادل جديد',
    tableRanges: 'يمكن تحديد الطاولات بنطاقات مثل 1-8، 12، 15-17. يرى كل نادل طاولاته فقط.',
    noWaitersYet: 'لا يوجد نادلون حاليا.', editWaiter: 'تعديل النادل',
    waiterNamePlaceholder: 'اسم النادل', tablesLabel: 'الطاولات (النطاقات مسموحة: 1-8، 12، 15-17)',
    tablesPlaceholder: 'مثال: 1-8، 12', onDutyLabel: 'في الخدمة', willSeeTables: 'الطاولات التي ستظهر:',
    noTablesAssignedYet: 'لم يتم تعيين طاولات.', pastTicketsStaffKept: 'يتم الاحتفاظ بتذاكر النادل السابقة مع اسمه.',
    orderHistory: 'التذاكر المفتوحة والطلبات خلال آخر 24 ساعة.', tableLabel: 'طاولة',
    restaurant: 'المطعم', printedName: 'الاسم (يُطبع على التذاكر)', currency: 'العملة',
    ticketPrinter: 'طابعة التذاكر', printerHelp: 'طابعة حرارية ESC/POS على الشبكة المحلية (معظم طابعات المطبخ، المنفذ 9100). اترك عنوان IP فارغا لتعطيلها؛ ويمكن طباعة التذاكر من الأجهزة اللوحية عبر المتصفح.',
    printerIp: 'عنوان IP للطابعة', printerPort: 'منفذ الطابعة',
    autoPrint: 'الطباعة تلقائيا عند وصول تذكرة إلى المطبخ',
    security: 'الأمان', newAdminPin: 'رمز إدارة جديد (4 أرقام على الأقل)',
    newPinPlaceholder: 'الرمز الجديد', changePin: 'تغيير الرمز', data: 'البيانات',
    localDataHelp: 'تُحفظ جميع البيانات محليا في data/restaurant.db بجانب server.py.',
    serverAddress: 'عنوان الخادم على هذه الشبكة:', exportData: '⬇ تصدير جميع البيانات (JSON)',
    settingsSaved: 'تم حفظ الإعدادات', pinMin: 'يجب أن يتكون الرمز من 4 أرقام على الأقل.',
    pinChanged: 'تم تغيير الرمز', exportDownloaded: 'تم تنزيل البيانات', exportFailed: 'تعذر التصدير: ',
    needConnection: 'يلزم الاتصال بالخادم', nameRequired: 'الاسم مطلوب.',
    validPrice: 'أدخل سعرا صالحا.', saved: 'تم الحفظ',
    orderItems: 'عنصر/عناصر', notePrefix: 'ملاحظة: ',     statusConnection: 'حالة الاتصال', outOfStock: '86 - العنصر غير متوفر', clear: 'مسح',
    deleteSuffix: '»؟', saveSettings: 'حفظ الإعدادات',
    noTablesShort: 'لا توجد طاولات', serverAddressLabel: 'عنوان الخادم على هذه الشبكة:',
    questionSuffix: '؟', restaurantName: 'طلبات المطعم', printerIpPlaceholder: 'مثال: 192.168.1.50',
    branch: 'الفرع', reservations: 'الحجوزات', newReservation: 'حجز جديد',
    guestName: 'اسم الضيف', contact: 'الهاتف / معلومات الاتصال', reservationTime: 'التاريخ والوقت',
    partySize: 'عدد الأشخاص', reservationNote: 'ملاحظة', booked: 'محجوز', seated: 'تم التسكين',
    noShow: 'لم يحضر', createReservation: 'إضافة حجز', sales: 'المبيعات',
    payment: 'الدفع', recordPayment: 'تسجيل دفعة', amount: 'المبلغ',
    method: 'طريقة الدفع', cash: 'نقدا', card: 'بطاقة', other: 'أخرى',
    splitItems: 'تقسيم حسب الأصناف', paid: 'مدفوع', balance: 'المتبقي', requestBill: 'طلب الفاتورة',
    analyticsPeriod: 'الفترة', topItems: 'الأصناف الأكثر مبيعا', revenue: 'الإيرادات المحصلة',
    newBranch: 'فرع جديد', copyMenu: 'نسخ القائمة والموظفين الحاليين',
    stock: 'المخزون المتبقي (فارغ = غير متتبع)', image: 'صورة الطبق', modifiers: 'الخيارات (سطر لكل خيار: الاسم:السعر)',
    noReservations: 'لا توجد حجوزات قادمة.', branchCreated: 'تم إنشاء الفرع',
    inventory: 'المخزون', noSales: 'لا توجد مبيعات مسجلة لهذه الفترة.',
    refund: 'استرداد', refundAmount: 'مبلغ الاسترداد', paymentRefunded: 'تم تسجيل الاسترداد',
    pageTitle: 'طلبات المطعم',
    staffPin: 'رمز PIN (اتركه فارغاً = بدون رمز)', staffRole: 'الدور', kitchenStation: 'محطة المطبخ',
    allStations: 'جميع المحطات', enterStaffPin: 'أدخل رمزك', waiterRoleLabel: 'نادل',
    kitchenRoleLabel: 'مطبخ', stationPick: 'اختر محطتك'
  },
  en: {
    offline: 'Offline - orders are saved on this device',
    waitOnline: 'order action(s) waiting - will send automatically',
    language: 'Language', roleHintMore: 'Use one tablet per station: waiters take orders, the kitchen sees tickets arrive in real time, and the admin manages the menu, staff and settings.',
    waiterRole: 'Waiter', kitchenRole: 'Kitchen', adminRole: 'Admin',
    whoUses: 'Who is using this tablet?', roleHint: 'The choice is remembered on this device.',
    roles: 'Roles', waiterSignin: 'Waiter sign-in', myTables: 'My tables', home: 'Home', viewSectionItems: 'View items',
    table: 'Table', free: 'Free', ready: 'Ready - serve!', orderSent: 'Order sent',
    cooking: 'Cooking', noTables: 'No tables assigned to you yet.',
    noWaiters: 'No waiters yet.',
    noOpen: 'No open tickets for this table yet.', tickets: 'Tickets',
    all: 'All', menu: 'Menu', searchMenu: 'Search the menu...', noDishes: 'No dishes match.',
    review: 'Review order', reviewOrder: 'Review order', keepEditing: 'Keep editing',
    sendKitchen: 'Send to kitchen', print: 'Print', served: 'Served', cancel: 'Cancel',
    ticket: 'Ticket', noteKitchen: 'Note for the kitchen (allergy, timing...)',
    noteOptional: 'optional', new: 'New', preparing: 'Preparing',
    sent: 'Sent', cancelled: 'Cancelled', nothingHere: 'Nothing here', startCooking: 'Start cooking',
    allReady: 'All ready', noOrders: 'No orders yet.',
    openTickets: 'Open tickets plus everything from the last 24 hours.',
    connecting: 'Connecting to server…', waiterHint: 'No waiters yet. Add staff in the Admin area.',
    switchWaiter: 'switch', ticketCount: 'ticket', ticketPlural: 'tickets', itemCount: 'item(s)',
    noteLabel: 'Note', noteItem: 'Note for this item', itemNotePlaceholder: 'e.g. no onions, well done',
    back: 'Back', save: 'Save', optional: 'optional', send: 'Send to kitchen',
    cancelTicketTitle: 'Cancel ticket #', cancelReason: 'Reason (shown in the kitchen log)',
    cancelReasonPlaceholder: 'e.g. customer changed their mind', keepTicket: 'Keep ticket',
    cancelTicket: 'Cancel ticket', keepItem: 'Keep item', cancelItem: 'Cancel item',
    item: 'item', alreadyReady: 'Already ready', itemReady: 'Item ready ✓', itemCooking: 'Item cooking…',
    cookingStarted: 'Cooking started', orderReady: 'All ready ✓', ticketServed: 'Ticket served ✓',
    ticketSent: 'sent to kitchen ✓', sendFailed: 'Could not send order: ',
    offlineSavedOrder: 'Offline - order saved and will send automatically when reconnected.',
    actionFailed: 'Could not complete action: ', offlineSavedAction: 'Offline - action saved and will send automatically when reconnected.',
    backOnline: 'Back online', rejected: 'Rejected: ',
    sections: 'Sections', menuTab: 'Menu', editSection: 'Edit section', waiters: 'Waiters', orders: 'Orders', settings: 'Settings',
    admin: 'Admin', restricted: 'Restricted', enterPin: 'Enter admin PIN',
    unlock: 'Unlock', defaultPin: 'Default PIN is 1234 - change it in Settings after signing in.',
    enterPinToast: 'Enter the PIN', adminUnlocked: 'Admin unlocked',
    wrongPin: 'Wrong PIN', serverUnavailable: 'Cannot reach server: ',
    newSection: 'New section', renameSection: 'Rename section', sectionPlaceholder: 'e.g. Salads',
    noSections: 'No sections yet - add your first one.', itemSingular: 'item', itemsPlural: 'items',
    active: 'active', hidden: 'hidden', hide: 'Hide', show: 'Show', delete: 'Delete',
    deleteQuestion: 'Delete “', hasItems: 'It still has ', moveOrDelete: ' item(s). Move or delete them first.',
    cannotUndo: 'This cannot be undone.', keep: 'Keep', deleted: 'Deleted',
    allSections: 'All sections', searchItems: 'Search items…', addItem: '＋ Item',
    noItemsMatch: 'No items match.', editItem: 'Edit item', newItem: 'New item',
    name: 'Name', price: 'Price', section: 'Section', description: 'Description (optional)',
    itemNamePlaceholder: 'e.g. Caesar Salad', descriptionPlaceholder: 'Short description shown to waiters',
    activeOnWaiter: 'Active (visible on waiter tablets)', pastTicketsKept: 'Past tickets keep their own copy of the item name and price.',
    noTables: 'no tables', offDuty: 'off duty', onDuty: 'On duty', newWaiter: 'New waiter',
    tableRanges: 'Tables accept ranges, e.g. 1-8, 12, 15-17. Each waiter sees only their own tables.',
    noWaitersYet: 'No waiters yet.', editWaiter: 'Edit waiter',
    waiterNamePlaceholder: 'waiter name', tablesLabel: 'Tables (ranges allowed: 1-8, 12, 15-17)',
    tablesPlaceholder: 'e.g. 1-8, 12', onDutyLabel: 'On duty', willSeeTables: 'Will see tables:',
    noTablesAssignedYet: 'No tables assigned yet.', pastTicketsStaffKept: 'Their past tickets are kept with their name.',
    orderHistory: 'Open tickets plus everything from the last 24 hours.', tableLabel: 'Table',
    restaurant: 'Restaurant', printedName: 'Name (printed on tickets)', currency: 'Currency',
    ticketPrinter: 'Ticket printer', printerHelp: 'ESC/POS thermal printer on the LAN (most kitchen printers, port 9100). Leave IP empty to disable; tickets can still be printed from any tablet via the browser.',
    printerIp: 'Printer IP', printerPort: 'Printer port',
    autoPrint: 'Print automatically when a ticket arrives in the kitchen',
    security: 'Security', newAdminPin: 'New admin PIN (4+ digits)',
    newPinPlaceholder: 'new PIN', changePin: 'Change PIN', data: 'Data',
    localDataHelp: 'Everything is stored locally in data/restaurant.db next to server.py.',
    serverAddress: 'Server address on this network:', exportData: '⬇ Export all data (JSON)',
    settingsSaved: 'Settings saved', pinMin: 'PIN must be at least 4 digits.',
    pinChanged: 'PIN changed', exportDownloaded: 'Export downloaded', exportFailed: 'Export failed: ',
    needConnection: 'Need connection', nameRequired: 'Name required.',
    validPrice: 'Enter a valid price.', saved: 'Saved',
    orderItems: 'item(s)', notePrefix: 'Note: ',     statusConnection: 'connection status', outOfStock: '86 - out of stock', clear: 'Clear',
    deleteSuffix: '”?', saveSettings: 'Save settings',
    noTablesShort: 'no tables', serverAddressLabel: 'Server address on this network:',
    questionSuffix: '?', restaurantName: 'Restaurant Orders', printerIpPlaceholder: 'e.g. 192.168.1.50',
    branch: 'Branch', reservations: 'Reservations', newReservation: 'New reservation',
    guestName: 'Guest name', contact: 'Phone / contact', reservationTime: 'Date and time',
    partySize: 'Party size', reservationNote: 'Note', booked: 'Booked', seated: 'Seated',
    noShow: 'No-show', createReservation: 'Add reservation', sales: 'Sales',
    payment: 'Payment', recordPayment: 'Record payment', amount: 'Amount',
    method: 'Payment method', cash: 'Cash', card: 'Card', other: 'Other',
    splitItems: 'Split by items', paid: 'Paid', balance: 'Due', requestBill: 'Request bill',
    analyticsPeriod: 'Period', topItems: 'Top-selling items', revenue: 'Payments received',
    newBranch: 'New branch', copyMenu: 'Copy current menu and staff',
    stock: 'Remaining stock (blank = not tracked)', image: 'Item image', modifiers: 'Options (one per line: name:price)',
    noReservations: 'No upcoming reservations.', branchCreated: 'Branch created',
    inventory: 'Inventory', noSales: 'No recorded sales for this period.',
    refund: 'Refund', refundAmount: 'Refund amount', paymentRefunded: 'Refund recorded',
    pageTitle: 'Restaurant Orders',
    staffPin: 'PIN code (leave blank = no PIN)', staffRole: 'Role', kitchenStation: 'Kitchen station',
    allStations: 'All stations', enterStaffPin: 'Enter your code', waiterRoleLabel: 'Waiter',
    kitchenRoleLabel: 'Kitchen', stationPick: 'Choose your station'
  }
};
var DATA_LABELS = {
  'My Restaurant': { fr: 'Mon restaurant', ar: 'مطعمي' },
  'Starters': { fr: 'Entrées', ar: 'المقبلات' },
  'Main Courses': { fr: 'Plats principaux', ar: 'الأطباق الرئيسية' },
  'Desserts': { fr: 'Desserts', ar: 'الحلويات' },
  'Drinks': { fr: 'Boissons', ar: 'المشروبات' },
  'Garlic Bread': { fr: "Pain à l'ail", ar: 'خبز بالثوم' },
  'Tomato Soup': { fr: 'Soupe à la tomate', ar: 'حساء الطماطم' },
  'Chicken Wings': { fr: 'Ailes de poulet', ar: 'أجنحة الدجاج' },
  'Margherita Pizza': { fr: 'Pizza Margherita', ar: 'بيتزا مارغريتا' },
  'Beef Burger': { fr: 'Burger au bœuf', ar: 'برغر لحم بقري' },
  'Grilled Salmon': { fr: 'Saumon grillé', ar: 'سلمون مشوي' },
  'Pasta Carbonara': { fr: 'Pâtes carbonara', ar: 'باستا كاربونارا' },
  'Cheesecake': { fr: 'Gâteau au fromage', ar: 'تشيز كيك' },
  'Tiramisu': { fr: 'Tiramisu', ar: 'تيراميسو' },
  'Ice Cream': { fr: 'Glace', ar: 'آيس كريم' },
  'Cola': { fr: 'Cola', ar: 'كولا' },
  'Sparkling Water': { fr: 'Eau gazeuse', ar: 'مياه غازية' },
  'Orange Juice': { fr: "Jus d'orange", ar: 'عصير برتقال' },
  'Espresso': { fr: 'Expresso', ar: 'إسبريسو' },
  'House Red Wine': { fr: 'Vin rouge maison', ar: 'نبيذ أحمر محلي' }
};
function localizedLabel(value) {
  var labels = DATA_LABELS[value];
  return labels && labels[S.lang] ? labels[S.lang] : value;
}
function sourceLabel(value) {
  var original = Object.keys(DATA_LABELS).filter(function (key) {
    return DATA_LABELS[key][S.lang] === value;
  })[0];
  return original || value;
}
function tr(key) {
  var lang = I18N[S.lang] ? S.lang : 'fr';
  return I18N[lang][key] || I18N.fr[key] || key;
}
function tStatus(status) {
  return status === 'sent' ? tr('sent')
    : status === 'preparing' ? tr('preparing')
    : status === 'ready' ? tr('ready')
    : status === 'served' ? tr('served')
    : status === 'cancelled' ? tr('cancelled')
    : status;
}
function langControl() {
  return '<select class="btn small" aria-label="' + tr('language') + '" onchange="setLang(this.value)">' +
    '<option value="fr"' + (S.lang === 'fr' ? ' selected' : '') + '>Français</option>' +
    '<option value="ar"' + (S.lang === 'ar' ? ' selected' : '') + '>العربية</option>' +
    '<option value="en"' + (S.lang === 'en' ? ' selected' : '') + '>English</option>' +
    '</select>';
}
function setLang(lang) {
  if (!I18N[lang]) lang = 'fr';
  S.lang = lang;
  try { localStorage.setItem('ro_lang', lang); } catch (e) {}
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = tr('pageTitle');
  render();
}
function loadLS() {
  try { S.lang = localStorage.getItem('ro_lang') || 'fr'; } catch (e) { S.lang = 'fr'; }
  if (!I18N[S.lang]) S.lang = 'fr';
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  document.title = tr('pageTitle');
  // Always start at the role picker; a tablet shared by the team must not
  // reopen in the previous user's Admin, Kitchen, or Waiter screen.
  S.role = null;
  try { localStorage.removeItem('ro_role'); } catch (e) {}
  try { S.waiterId = JSON.parse(sessionStorage.getItem('ro_waiter') || 'null'); } catch (e) {}
  try { S.cart = JSON.parse(localStorage.getItem('ro_cart') || '{}'); } catch (e) { S.cart = {}; }
  try { S.queue = JSON.parse(localStorage.getItem('ro_queue') || '[]'); } catch (e) { S.queue = []; }
  try { S.branchId = parseInt(localStorage.getItem('ro_branch') || '1', 10) || 1; } catch (e) { S.branchId = 1; }
  if (!S.cart || typeof S.cart !== 'object') S.cart = {};
  if (!Array.isArray(S.queue)) S.queue = [];
  S.adminPin = sessionStorage.getItem('ro_adminpin') || null;
}
function saveLS(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

// ---------- api + offline queue ----------
async function api(path, method, body, branchId) {
  var headers = { 'Content-Type': 'application/json', 'X-Branch-ID': String(branchId || S.branchId || 1) };
  if (S.role) headers['X-Actor-Role'] = String(S.role);
  if (S.waiterId != null) headers['X-Actor-ID'] = String(S.waiterId);
  if (S.adminPin) headers['X-Admin-Pin'] = S.adminPin;
  var res = await fetch(path, {
    method: method || 'GET', headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var j = null;
  try { j = await res.json(); } catch (e) { j = { ok: false, error: 'Bad response from server' }; }
  if (!res.ok || j.ok === false) {
    var err = new Error(j.error || ('HTTP ' + res.status));
    err.code = res.status; throw err;
  }
  return j;
}
function branchControl() {
  var branches = S.data && S.data.branches ? S.data.branches : [];
  if (branches.length < 2) return '';
  return '<select class="btn small" aria-label="' + tr('branch') + '" onchange="changeBranch(this.value)">' +
    branches.map(function (b) {
      return '<option value="' + b.id + '"' + (b.id === S.branchId ? ' selected' : '') + '>' +
        esc(b.name) + '</option>';
    }).join('') + '</select>';
}
function changeBranch(value) {
  var next = parseInt(value, 10);
  if (!next || next === S.branchId) return;
  S.branchId = next;
  saveLS('ro_branch', next);
  S.waiterId = null; S.tableNo = null; S.cart = {};
  S.catalogLoadedFor = null; S.catalogProducts = []; S.catalogGroups = [];
  sessionStorage.removeItem('ro_waiter'); saveLS('ro_cart', {});
  S.rev = -1; poll();
  if (S.role === 'admin' && S.adminTab === 'sales') loadSales(S.salesPeriod || '7d');
}
function enqueue(path, body) {
  S.queue.push({ path: path, body: body, branchId: S.branchId });
  saveLS('ro_queue', S.queue);
  renderConn();
}
// Queue only carries order-critical, idempotent mutations (create order /
// status changes). A server-side rejection (bad request) is dropped so the
// queue never spins forever; a network error keeps items queued.
async function flushQueue() {
  if (!S.queue.length || !navigator.onLine) { renderConn(); return; }
  while (S.queue.length) {
    var item = S.queue[0];
    try {
      await api(item.path, 'POST', item.body, item.branchId);
      S.queue.shift(); saveLS('ro_queue', S.queue);
    } catch (e) {
      if (e.code) { S.queue.shift(); saveLS('ro_queue', S.queue); toast(tr('rejected') + e.message); }
      else break;
    }
  }
  renderConn();
  if (S.role) poll();
}

// ---------- polling ----------
async function poll() {
  try {
    var j = await api('/api/state');
    var wasOnline = S.online;
    S.online = true; S.data = j;
    S.skew = j.now - Date.now() / 1000;
    if (S.role === 'kitchen') detectNewOrders(j);
    var changed = j.rev !== S.rev;
    S.rev = j.rev;
    if (changed && S.role) render();
    if (!wasOnline) { toast(tr('backOnline')); flushQueue(); }
    renderConn();
  } catch (e) {
    S.online = false;
    renderConn();
  }
}
var sseSource = null;
function startSSE() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (!window.EventSource) { startPollFallback(); return; }
  sseSource = new EventSource('/api/events');
  sseSource.onmessage = function(e) {
    try {
      var d = JSON.parse(e.data);
      if (d.rev !== undefined && d.rev !== S.rev) poll();
    } catch(err) {}
  };
  sseSource.onerror = function() {
    sseSource.close(); sseSource = null;
    setTimeout(startSSE, 2000);
  };
}
function startPollFallback() {
  if (S.pollT) clearInterval(S.pollT);
  poll();
  S.pollT = setInterval(poll, S.role === 'kitchen' ? 2000 : 3000);
}
function startPoll() { startSSE(); }
function detectNewOrders(j) {
  (j.orders || []).forEach(function (o) {
    if (o.status === 'sent' && !S.seen[o.id]) { beep(); }
    S.seen[o.id] = true;
  });
}
function beep() {
  try {
    var ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    [880, 1175].forEach(function (f, i) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      o.connect(g); g.connect(ctx.destination);
      var t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.001, t); g.gain.linearRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.start(t); o.stop(t + 0.18);
    });
  } catch (e) {}
}

// ---------- ui atoms ----------
var toastT = null;
function toast(msg) {
  var t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2600);
}
function dlg(html) {
  var d = $('#dlg');
  d.innerHTML = '<div class="dlg-box">' + html + '</div>';
  d.showModal(); return d;
}
function closeDlg() { var d = $('#dlg'); if (d.open) d.close(); d.innerHTML = ''; }
function renderConn() {
  var bar = $('#connbar');
  if (!S.online || S.queue.length) {
    bar.classList.remove('hidden');
    if (S.queue.length) {
      var noun = S.queue.length === 1 ? 'order/action waiting to send' : 'orders/actions waiting to send';
      bar.innerHTML = '⚠ ' + S.queue.length + ' ' + noun +
        ' <button class="btn small" onclick="retryQueued()">Retry now</button>';
    } else {
      bar.textContent = '⚠ ' + tr('offline');
    }
  } else bar.classList.add('hidden');
}
function retryQueued() { flushQueue(); }
function connDot() { return '<span class="dot ' + (S.online ? '' : 'off') + '" title="' + tr('statusConnection') + '"></span>'; }

// ---------- render dispatcher ----------
function render() {
  // preserve focus/selection of an input across re-render (search boxes)
  var ae = document.activeElement, aeId = ae ? ae.id : null, pos = null;
  if (ae && ae.id && ae.selectionStart != null) pos = ae.selectionStart;
  var app = $('#app');
  if (S.role && S.data == null) { app.innerHTML = '<div class="loading">' + tr('connecting') + '</div>'; return; }
  if (!S.role) renderRoleSelect(app);
  else if (S.role === 'waiter') renderWaiter(app);
  else if (S.role === 'kitchen') renderKitchen(app);
  else if (S.role === 'admin') renderAdmin(app);
  if (aeId) {
    var el = document.getElementById(aeId);
    if (el) { el.focus(); if (pos != null && el.setSelectionRange) { try { el.setSelectionRange(pos, pos); } catch (e) {} } }
  }
}
function setRole(r) {
  S.role = r; saveLS('ro_role', null); S.tableNo = null;
  startSSE(); render();
}
function goHome() {
  S.role = null; S.waiterId = null; S.tableNo = null; S.kitchenStation = null; S.kitchenStaffId = null;
  S.adminPin = null;
  sessionStorage.removeItem('ro_waiter'); sessionStorage.removeItem('ro_adminpin');
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (S.pollT) { clearInterval(S.pollT); S.pollT = null; }
  saveLS('ro_role', null); render();
}

// ---------- role select ----------
function renderRoleSelect(app) {
  var name = S.data ? esc(localizedLabel(S.data.restaurant)) : tr('restaurantName');
  app.innerHTML =
    '<div class="role-wrap">' +
      '<div class="brand">' + name + '</div>' +
      '<div style="margin-bottom:18px">' + branchControl() + langControl() + '</div>' +
      '<h1>' + tr('whoUses') + '</h1>' +
      '<div class="roles">' +
        '<button class="role" onclick="chooseRole(\'waiter\')"><span class="ricon">🧑‍🍽️</span>' + tr('waiterRole') + '</button>' +
        '<button class="role" onclick="chooseRole(\'kitchen\')"><span class="ricon">👨‍🍳</span>' + tr('kitchenRole') + '</button>' +
        '<button class="role" onclick="chooseRole(\'admin\')"><span class="ricon">⚙️</span>' + tr('adminRole') + '</button>' +
      '</div>' +
      '<div class="hint">' + tr('roleHint') + ' ' + tr('roleHintMore') + '</div>' +
    '</div>';
}
function chooseRole(r) {
  if (r === 'admin' && sessionStorage.getItem('ro_adminpin')) S.adminPin = sessionStorage.getItem('ro_adminpin');
  if (r === 'kitchen' && S.data) {
    var kitchenStaff = (S.data.staff || []).filter(function(x){ return x.role === 'kitchen' && x.kitchen_station; });
    if (kitchenStaff.length > 0) {
      showStationPicker();
      return;
    }
  }
  setRole(r);
}
function showStationPicker() {
  var kitchenStaff = (S.data.staff || []).filter(function(x){ return x.role === 'kitchen' && x.kitchen_station; });
  var staffBtns = kitchenStaff.map(function(x){
    return '<button class="role" onclick="pickKitchenMember(' + x.id + ')">' +
      '<span class="ricon">🍳</span>' + esc(x.name) + ' <small>· ' + esc(x.kitchen_station) + '</small></button>';
  }).join('');
  var app = $('#app');
  app.innerHTML =
    '<div class="topbar"><div class="tb-left"><span class="tb-title">👨‍🍳 ' + tr('stationPick') + '</span></div>' +
    '<div class="tb-right"><button class="btn small" onclick="render()">← ' + tr('roles') + '</button></div></div>' +
    '<div class="pad"><div class="pick-grid">' +
      '<button class="role" onclick="pickStation(null,false)"><span class="ricon">🌐</span>' + tr('allStations') + '</button>' +
      staffBtns +
    '</div></div>';
}
var stationPinBuf = '';
function pickKitchenMember(id) {
  var member = (S.data.staff || []).filter(function(x){return x.id === id;})[0];
  if (!member) return;
  if (!member.has_pin) { toast('This staff member needs a password set by the admin.'); return; }
  stationPinBuf = '';
  dlg('<h2>' + esc(member.name) + ' · ' + esc(member.kitchen_station) + '</h2><input id="kitchen-member-pin" class="in" type="password" autocomplete="current-password" placeholder="' + tr('enterStaffPin') + '">' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button><button class="btn primary" onclick="confirmKitchenMember(' + id + ')">' + tr('unlock') + ' ✓</button></div>');
}
async function confirmKitchenMember(id) {
  var pin = document.getElementById('kitchen-member-pin').value;
  try { var auth = await api('/api/staff/auth', 'POST', {staff_id:id, pin:pin});
    closeDlg(); S.kitchenStation = auth.kitchen_station; S.kitchenStaffId = auth.staff_id; setRole('kitchen');
  } catch(e) { toast(e.code === 403 ? tr('wrongPin') : e.message); }
}
function pickStation(station, needsPin) {
  if (!needsPin || !station) {
    S.kitchenStation = station;
    setRole('kitchen');
    return;
  }
  stationPinBuf = '';
  dlg('<h2>' + tr('enterStaffPin') + ' — ' + esc(station) + '</h2>' +
    '<div class="pindots" id="station-pindots"></div>' +
    '<div class="pinpad">' +
      [1,2,3,4,5,6,7,8,9].map(function(n){return '<button onclick="stationPinKey('+n+')">'+n+'</button>';}).join('') +
      '<button onclick="stationPinClear()">' + tr('clear') + '</button><button onclick="stationPinKey(0)">0</button><button onclick="stationPinBack()">⌫</button>' +
    '</div>' +
    '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
    '<button class="btn primary" onclick="confirmStationPin(\'' + esc(station) + '\')">' + tr('unlock') + ' ✓</button></div>');
  drawStationPinDots();
}
function drawStationPinDots() {
  var el = document.getElementById('station-pindots');
  if (!el) return;
  el.innerHTML = [0,1,2,3].map(function(i){
    return '<span class="' + (i < stationPinBuf.length ? 'f' : '') + '"></span>';
  }).join('');
}
function stationPinKey(n) { if (stationPinBuf.length < 8) { stationPinBuf += n; drawStationPinDots(); } }
function stationPinBack() { stationPinBuf = stationPinBuf.slice(0,-1); drawStationPinDots(); }
function stationPinClear() { stationPinBuf = ''; drawStationPinDots(); }
async function confirmStationPin(station) {
  var kitchenStaff = (S.data.staff || []).filter(function(x){
    return x.role === 'kitchen' && x.kitchen_station === station && x.has_pin;
  });
  var staffMember = kitchenStaff[0];
  if (!staffMember) { closeDlg(); S.kitchenStation = station; setRole('kitchen'); return; }
  try {
    await api('/api/staff/auth', 'POST', { staff_id: staffMember.id, pin: stationPinBuf });
    stationPinBuf = '';
    closeDlg(); S.kitchenStation = station; setRole('kitchen');
  } catch (e) {
    stationPinBuf = '';
    if (e.code === 403) toast(tr('wrongPin'));
    else toast(tr('actionFailed') + e.message);
    drawStationPinDots();
  }
}

// ---------- waiter: sign-in + home ----------
function renderWaiter(app) {
  var me = S.data ? S.data.staff.filter(function (s) { return s.id === S.waiterId; })[0] : null;
  if (!me) { renderWaiterSelect(app); return; }
  if (S.tableNo) renderTableScreen(app, me);
  else renderWaiterHome(app, me);
}
function renderWaiterSelect(app) {
  var staff = S.data ? S.data.staff.filter(function (s) { return s.active; }) : [];
  var btns = staff.map(function (s) {
    return '<button class="role" onclick="pickWaiter(' + s.id + ')"><span class="ricon">🧑‍🍽️</span>' + esc(s.name) + '</button>';
  }).join('');
  app.innerHTML =
    '<div class="topbar"><div class="tb-left"><span class="tb-title">' + tr('waiterSignin') + '</span></div>' +
      '<div class="tb-right">' + branchControl() + langControl() + '<button class="btn small" onclick="S.role=null;saveLS(\'ro_role\',null);render()">← ' + tr('roles') + '</button>' + connDot() + '</div></div>' +
    '<div class="pad"><div class="pick-grid">' + (btns || '<p class="empty">' + tr('waiterHint') + '</p>') + '</div></div>';
}
var staffPinBuf = '';
function pickWaiter(id) {
  var s = (S.data.staff || []).filter(function(x){return x.id===id;})[0];
  if (!s || !s.has_pin) { toast('This staff member needs a password set by the admin.'); return; }
  if (s && s.has_pin) {
    staffPinBuf = '';
    dlg('<h2>' + tr('enterStaffPin') + '</h2>' +
      '<div class="pindots" id="staff-pindots"></div>' +
      '<div class="pinpad">' +
        [1,2,3,4,5,6,7,8,9].map(function(n){return '<button onclick="staffPinKey('+n+')">'+n+'</button>';}).join('') +
        '<button onclick="staffPinClear()">' + tr('clear') + '</button><button onclick="staffPinKey(0)">0</button><button onclick="staffPinBack()">⌫</button>' +
      '</div>' +
      '<div class="dlg-foot"><button class="btn" onclick="closeDlg()">' + tr('cancel') + '</button>' +
      '<button class="btn primary" onclick="confirmStaffPin(' + id + ')">' + tr('unlock') + ' ✓</button></div>');
    drawStaffPinDots();
    return;
  }
}
function drawStaffPinDots() {
  var el = document.getElementById('staff-pindots');
  if (!el) return;
  el.innerHTML = [0,1,2,3].map(function(i){
    return '<span class="' + (i < staffPinBuf.length ? 'f' : '') + '"></span>';
  }).join('');
}
function staffPinKey(n) { if (staffPinBuf.length < 8) { staffPinBuf += n; drawStaffPinDots(); } }
function staffPinBack() { staffPinBuf = staffPinBuf.slice(0,-1); drawStaffPinDots(); }
function staffPinClear() { staffPinBuf = ''; drawStaffPinDots(); }
async function confirmStaffPin(id) {
  try {
    await api('/api/staff/auth', 'POST', { staff_id: id, pin: staffPinBuf });
    staffPinBuf = '';
    S.waiterId = id; sessionStorage.setItem('ro_waiter', JSON.stringify(id)); S.tableNo = null;
    closeDlg(); render();
  } catch (e) {
    staffPinBuf = '';
    if (e.code === 403) toast(tr('wrongPin'));
    else toast(tr('actionFailed') + e.message);
    drawStaffPinDots();
  }
}

function waiterHeader(me, backTo) {
  var right = branchControl() + langControl() + '<button class="btn small" onclick="goHome()">⌂ ' + tr('home') + '</button>' +
    '<button class="btn small" onclick="switchWaiter()">👤 ' + esc(me.name) + ' ▸ ' + tr('switchWaiter') + '</button>' + connDot();
  var left = backTo
    ? '<button class="btn small" onclick="backToTables()">←</button><span class="tb-title">' + tr('table') + ' ' + S.tableNo + '</span>'
    : '<span class="tb-title">' + tr('myTables') + '</span><span class="tb-sub">' + esc(localizedLabel(S.data.restaurant)) + '</span>';
  return '<div class="topbar"><div class="tb-left">' + left + '</div><div class="tb-right">' + right + '</div></div>';
}
function switchWaiter() { S.waiterId = null; sessionStorage.removeItem('ro_waiter'); S.tableNo = null; render(); }
function backToTables() { S.tableNo = null; render(); }

function renderWaiterHome(app, me) {
  var tables = parseTables(me.tables);
  var orders = S.data.orders || [];
  var cards = tables.map(function (tableNo) {
    var open = openOrders(orders.filter(function (o) { return o.table_no === tableNo; }));
    var st = null, label = tr('free');
    if (open.some(function (o) { return o.status === 'ready'; })) { st = 'ready'; label = tr('ready'); }
    else if (open.some(function (o) { return o.status === 'sent'; })) { st = 'sent'; label = tr('orderSent'); }
    else if (open.some(function (o) { return o.status === 'preparing'; })) { st = 'preparing'; label = tr('cooking'); }
    return '<button class="tcard st-' + (st || 'free') + '" onclick="openTable(' + tableNo + ')">' +
      '<span class="tnum">' + tableNo + '</span><span class="tstat">' + label + '</span>' +
      (open.length ? '<span class="tag">' + open.length + ' ' + tr(open.length === 1 ? 'ticketCount' : 'ticketPlural') + '</span>' : '') +
      '</button>';
  }).join('');
  app.innerHTML = waiterHeader(me, false) +
    '<div class="pad">' +
    (cards ? '<div class="tables-grid">' + cards + '</div>'
           : '<div class="empty">' + tr('noTables') + '</div>') +
    '</div>';
}
function openTable(t) { S.tableNo = t; S.sectionFilter = 0; S.search = ''; render(); }
