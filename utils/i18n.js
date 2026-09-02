/**
 * 界面语言基础设施。
 *
 * `system` 不直接保存为某种语言，而是在每次启动时读取微信提供的系统语言；
 * 用户手动选择后则优先使用手动选择。业务数据（账户名、发行商、备注等）不参与翻译。
 */

const SUPPORTED_LOCALES = ['system', 'zh-Hans', 'en', 'ja', 'zh-Hant'];

const LOCALE_OPTIONS = [
  { value: 'system', label: '跟随系统 / System' },
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'zh-Hant', label: '繁體中文' },
];

const ABOUT_COPY = {
  'zh-Hans': {
    versionPrefix: '版本', cloudTitle: '建议配置个人云存储',
    cloudText: '本小程序不代管用户账号。请在备份与恢复中填写你自己的 WebDAV 地址、用户名和应用密码，备份内容会先加密再上传。',
    introTitle: '小程序简介',
    introOne: '小产品实验室 OTP 是一款简洁的双重验证码工具，帮助你安全管理 TOTP 验证码、密码和二维码转换内容。',
    introTwo: '数据默认保存在微信本地加密存储中，导出和同步功能由用户主动控制。',
    updatesTitle: '产品更新日志', updateName: '本地迁移与体验完善',
    updateOne: '新增单条与全部 OTP 的加密迁移二维码。全部导出会自动分成多张二维码，接收端连续扫码收齐后再解密并合并，适合设备间本地迁移。',
    updateTwo: '优化微信加密备份导入导出路径；第一次保存数据后才提示设置备份密码，不阻断保存，且支持经确认后使用空密码。',
    updateThree: '优化浅色、深色与跟随系统主题切换，让界面回归验证码、密码、迁移与备份等核心操作。',
    follow: '更多产品更新请关注微信公众号「小产品实验室」', copyOfficial: '复制公众号名称', copiedOfficial: '已复制',
  },
  en: {
    versionPrefix: 'Version', cloudTitle: 'Use your own cloud storage',
    cloudText: 'This mini program does not host your accounts. In Backup & Restore, enter your own WebDAV address, username, and app password. Backups are encrypted before upload.',
    introTitle: 'About',
    introOne: 'Tiny Product Lab OTP is a simple two-factor authentication tool for securely managing TOTP codes, passwords, and QR-based transfers.',
    introTwo: 'Data is stored in WeChat encrypted local storage by default. Export and sync are always initiated by you.',
    updatesTitle: 'What’s new', updateName: 'Local migration and experience improvements',
    updateOne: 'Added encrypted migration QR codes for individual and full OTP exports. Full exports are split into multiple QR codes and merged only after the receiving device scans every part.',
    updateTwo: 'Improved encrypted backup import and export. A backup password is suggested after your first saved item without blocking saving; an empty password remains available after confirmation.',
    updateThree: 'Improved light, dark, and system theme switching so the app stays focused on codes, passwords, migration, and backups.',
    follow: 'For product updates, follow the WeChat Official Account “小产品实验室”.', copyOfficial: 'Copy official account name', copiedOfficial: 'Copied',
  },
  ja: {
    versionPrefix: 'バージョン', cloudTitle: '個人用クラウドストレージの設定をおすすめします',
    cloudText: 'このミニプログラムはユーザーアカウントを管理しません。バックアップと復元で、ご自身の WebDAV アドレス、ユーザー名、アプリパスワードを入力してください。バックアップは暗号化してからアップロードされます。',
    introTitle: 'アプリについて',
    introOne: 'Tiny Product Lab OTP は、TOTP コード、パスワード、QR コードによる移行を安全に管理するためのシンプルな二段階認証ツールです。',
    introTwo: 'データは標準で WeChat のローカル暗号化ストレージに保存されます。エクスポートと同期は常にユーザー自身が実行します。',
    updatesTitle: '更新履歴', updateName: 'ローカル移行と使い勝手の改善',
    updateOne: '単体・全件 OTP 用の暗号化移行 QR コードを追加しました。全件エクスポートは複数の QR コードに分割され、受信側で全て読み取った後に復号・統合されます。',
    updateTwo: '暗号化バックアップのインポートとエクスポートを改善しました。最初の保存後にバックアップパスワードを案内し、保存を妨げません。確認後は空のパスワードも選べます。',
    updateThree: 'ライト・ダーク・システム連動テーマを改善し、コード、パスワード、移行、バックアップに集中できるようにしました。',
    follow: '更新情報は WeChat 公式アカウント「小产品实验室」をご覧ください。', copyOfficial: '公式アカウント名をコピー', copiedOfficial: 'コピーしました',
  },
  'zh-Hant': {
    versionPrefix: '版本', cloudTitle: '建議設定個人雲端儲存',
    cloudText: '本小程式不代管使用者帳號。請在備份與還原中填寫自己的 WebDAV 位址、使用者名稱和應用程式密碼，備份內容會先加密再上傳。',
    introTitle: '小程式簡介',
    introOne: '小產品實驗室 OTP 是一款簡潔的雙重驗證工具，協助你安全管理 TOTP 驗證碼、密碼和 QR Code 移轉內容。',
    introTwo: '資料預設儲存在微信本機加密儲存中，匯出與同步皆由使用者主動控制。',
    updatesTitle: '產品更新日誌', updateName: '本機移轉與體驗完善',
    updateOne: '新增單筆與全部 OTP 的加密移轉 QR Code。全部匯出會自動分成多張 QR Code，接收端連續掃完後才會解密並合併，適合裝置間本機移轉。',
    updateTwo: '改善微信加密備份匯入匯出流程；第一次儲存資料後才提示設定備份密碼，不阻斷儲存，確認後也可使用空密碼。',
    updateThree: '改善淺色、深色與跟隨系統主題切換，讓介面回歸驗證碼、密碼、移轉與備份等核心操作。',
    follow: '更多產品更新請關注微信公眾號「小产品实验室」。', copyOfficial: '複製公眾號名稱', copiedOfficial: '已複製',
  },
};

function normalizeSystemLocale(language) {
  const value = String(language || '').replace(/_/g, '-').toLowerCase();
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('en')) return 'en';
  // 台湾、香港、澳门的系统语言优先繁中；其他中文环境默认简中。
  if (/^zh-(tw|hk|mo)/.test(value) || /hant/.test(value)) return 'zh-Hant';
  return 'zh-Hans';
}

function getSystemLocale() {
  try {
    if (typeof wx !== 'undefined' && wx.getSystemInfoSync) {
      return normalizeSystemLocale(wx.getSystemInfoSync().language);
    }
  } catch (error) { /* 读取失败时保持简中，不能阻断启动 */ }
  return 'zh-Hans';
}

function resolveLocale(preference) {
  const selected = SUPPORTED_LOCALES.includes(preference) ? preference : 'system';
  return selected === 'system' ? getSystemLocale() : selected;
}

function optionIndex(value) {
  const index = LOCALE_OPTIONS.findIndex((item) => item.value === value);
  return index < 0 ? 0 : index;
}

function about(locale) {
  return ABOUT_COPY[resolveLocale(locale)] || ABOUT_COPY['zh-Hans'];
}

const OTP_COPY = {
  'zh-Hans': { title: 'TOTP 验证码', subtitle: '验证码在本地计算，不联网', search: '搜索账户或发行商', filter: '筛选排序', time: '按时间', name: '按名称', manual: '手动排序', drag: '长按卡片拖动调整顺序', unnamed: '未命名', copy: '点击复制', emptySearch: '没有匹配的验证码', empty: '还没有验证码', retry: '换个关键词试试', emptyHint: '在各网站的「双重验证 / 两步验证」页面\\n扫描二维码即可添加', gestureHint: '上滑添加 · 下滑搜索', manualInput: '手动输入' },
  en: { title: 'TOTP codes', subtitle: 'Generated locally, never online', search: 'Search account or issuer', filter: 'Filter and sort', time: 'By time', name: 'By name', manual: 'Manual order', drag: 'Long press and drag a card to reorder', unnamed: 'Untitled', copy: 'Tap to copy', emptySearch: 'No matching codes', empty: 'No codes yet', retry: 'Try another keyword', emptyHint: 'On a site’s two-factor authentication page,\\nscan its QR code to add it', gestureHint: 'Swipe up to add · swipe down to search', manualInput: 'Enter manually' },
  ja: { title: 'TOTP 認証コード', subtitle: 'コードは端末内で生成され、通信しません', search: 'アカウントまたは発行元を検索', filter: '絞り込みと並べ替え', time: '時間順', name: '名前順', manual: '手動並べ替え', drag: 'カードを長押ししてドラッグすると並べ替えできます', unnamed: '名前なし', copy: 'タップしてコピー', emptySearch: '一致するコードがありません', empty: '認証コードはまだありません', retry: '別のキーワードを試してください', emptyHint: '各サイトの二段階認証ページで\\nQR コードを読み取って追加します', gestureHint: '上にスワイプで追加・下にスワイプで検索', manualInput: '手入力' },
  'zh-Hant': { title: 'TOTP 驗證碼', subtitle: '驗證碼在本機計算，不連網', search: '搜尋帳號或發行商', filter: '篩選與排序', time: '依時間', name: '依名稱', manual: '手動排序', drag: '長按卡片並拖曳即可調整順序', unnamed: '未命名', copy: '點選複製', emptySearch: '沒有符合的驗證碼', empty: '還沒有驗證碼', retry: '換個關鍵字試試', emptyHint: '在各網站的「雙重驗證 / 兩步驗證」頁面\\n掃描 QR Code 即可新增', gestureHint: '上滑新增 · 下滑搜尋', manualInput: '手動輸入' },
};

const HOME_COPY = {
  'zh-Hans': {
    panes: [{ title: '实用工具', sub: '静态密码账本 · 二维码 · 密码生成' }, { title: 'OTP', sub: '小产品实验室' }, { title: '数据管理', sub: '备份 · 同步 · 回收站' }],
    menuLanguage: '语言 / Language', menuSettings: '设置', menuFeedback: '意见反馈', menuShare: '转发小程序', menuAbout: '关于', addTitle: '添加验证码', scan: '扫码添加', manualInput: '手动输入', batchImport: '批量导入', exportOtp: '导出 OTP 信息',
    passwordBook: '静态密码账本', passwordBookSub: '个账号 · 分组、搜索和管理', qr: '二维码转换', qrSub: '将文字或链接转换为二维码并保存', generator: '密码生成器', generatorSub: '长度、大小写、数字、符号可配',
    search: '搜索账户或发行商', filter: '筛选排序', time: '按时间', name: '按名称', manual: '手动排序', drag: '长按卡片拖动调整顺序', unnamed: '未命名', copy: '点击复制', seconds: '秒',
    webdav: 'WebDAV 配置', webdavSub: '配置地址、用户名和应用密码', cloudBackup: '云端备份与恢复', localBackup: '本地备份', localBackupSub: '导出或恢复本地加密备份', trash: '回收站', trashSub: '项记录 · 保留', toolsTab: '实用工具', dataTab: '数据管理',
  },
  en: {
    panes: [{ title: 'Tools', sub: 'Password vault · QR code · Generator' }, { title: 'OTP', sub: '小产品实验室' }, { title: 'Data', sub: 'Backup · Sync · Trash' }],
    menuLanguage: 'Language / 语言', menuSettings: 'Settings', menuFeedback: 'Feedback', menuShare: 'Share mini program', menuAbout: 'About', addTitle: 'Add OTP code', scan: 'Scan QR code', manualInput: 'Enter manually', batchImport: 'Import in bulk', exportOtp: 'Export OTP data',
    passwordBook: 'Password vault', passwordBookSub: 'accounts · groups, search, and management', qr: 'QR code converter', qrSub: 'Turn text or links into a QR code', generator: 'Password generator', generatorSub: 'Length, cases, numbers, and symbols',
    search: 'Search account or issuer', filter: 'Filter and sort', time: 'By time', name: 'By name', manual: 'Manual order', drag: 'Long press and drag a card to reorder', unnamed: 'Untitled', copy: 'Tap to copy', seconds: 's',
    webdav: 'WebDAV settings', webdavSub: 'Set address, username, and app password', cloudBackup: 'Cloud backup & restore', localBackup: 'Local backup', localBackupSub: 'Export or restore an encrypted local backup', trash: 'Trash', trashSub: 'items · retain for', toolsTab: 'Tools', dataTab: 'Data',
  },
  ja: {
    panes: [{ title: 'ツール', sub: 'パスワード帳・QR コード・生成' }, { title: 'OTP', sub: '小产品实验室' }, { title: 'データ', sub: 'バックアップ・同期・ゴミ箱' }],
    menuLanguage: '言語 / Language', menuSettings: '設定', menuFeedback: 'フィードバック', menuShare: 'ミニプログラムを共有', menuAbout: 'アプリについて', addTitle: '認証コードを追加', scan: 'QR コードを読み取る', manualInput: '手入力', batchImport: '一括インポート', exportOtp: 'OTP 情報をエクスポート',
    passwordBook: 'パスワード帳', passwordBookSub: '件のアカウント・グループ・検索・管理', qr: 'QR コード変換', qrSub: 'テキストやリンクを QR コードにして保存', generator: 'パスワード生成', generatorSub: '長さ・英字・数字・記号を設定',
    search: 'アカウントまたは発行元を検索', filter: '絞り込みと並べ替え', time: '時間順', name: '名前順', manual: '手動並べ替え', drag: 'カードを長押ししてドラッグすると並べ替えできます', unnamed: '名前なし', copy: 'タップしてコピー', seconds: '秒',
    webdav: 'WebDAV 設定', webdavSub: 'アドレス、ユーザー名、アプリパスワードを設定', cloudBackup: 'クラウドのバックアップと復元', localBackup: 'ローカルバックアップ', localBackupSub: '暗号化したローカルバックアップを出力・復元', trash: 'ゴミ箱', trashSub: '件・保持期間', toolsTab: 'ツール', dataTab: 'データ',
  },
  'zh-Hant': {
    panes: [{ title: '實用工具', sub: '靜態密碼帳本 · QR Code · 密碼產生' }, { title: 'OTP', sub: '小产品实验室' }, { title: '資料管理', sub: '備份 · 同步 · 垃圾桶' }],
    menuLanguage: '語言 / Language', menuSettings: '設定', menuFeedback: '意見回饋', menuShare: '轉發小程式', menuAbout: '關於', addTitle: '新增驗證碼', scan: '掃碼新增', manualInput: '手動輸入', batchImport: '批次匯入', exportOtp: '匯出 OTP 資訊',
    passwordBook: '靜態密碼帳本', passwordBookSub: '個帳號 · 分組、搜尋和管理', qr: 'QR Code 轉換', qrSub: '將文字或連結轉換為 QR Code 並儲存', generator: '密碼產生器', generatorSub: '長度、大小寫、數字、符號可設定',
    search: '搜尋帳號或發行商', filter: '篩選與排序', time: '依時間', name: '依名稱', manual: '手動排序', drag: '長按卡片並拖曳即可調整順序', unnamed: '未命名', copy: '點選複製', seconds: '秒',
    webdav: 'WebDAV 設定', webdavSub: '設定位址、使用者名稱和應用程式密碼', cloudBackup: '雲端備份與還原', localBackup: '本機備份', localBackupSub: '匯出或還原本機加密備份', trash: '垃圾桶', trashSub: '項記錄 · 保留', toolsTab: '實用工具', dataTab: '資料管理',
  },
};

const SETTINGS_COPY = {
  'zh-Hans': { appearance: '外观', theme: '主题模式', themeSystem: '跟随系统深浅色', themeLight: '始终使用浅色', themeDark: '始终使用深色', language: '语言 / Language', languageHint: '可跟随系统，也可手动选择', data: '数据', trash: '回收站保留时间', history: '生成历史保存数量', biometric: '生物识别锁定', biometricHint: '再次打开小程序时使用指纹或面容验证', clipboard: '复制后提醒', clipboardHint: '小程序无法自动清空剪贴板，只能提醒', storage: '存储占用', privacy: '隐私与权限', policy: '隐私协议', policyHint: '了解本地加密、备份和数据处理方式', permissions: '权限管理', permissionsHint: '查看扫码、文件、剪贴板和本地存储权限说明', clear: '清除全部本地数据', clearHint: '清除前请确认已导出备份，此操作不可恢复。' },
  en: { appearance: 'Appearance', theme: 'Theme', themeSystem: 'Follow system appearance', themeLight: 'Always use light mode', themeDark: 'Always use dark mode', language: 'Language', languageHint: 'Follow the system or choose manually', data: 'Data', trash: 'Trash retention', history: 'Password history retention', biometric: 'Biometric lock', biometricHint: 'Use fingerprint or face verification when reopening', clipboard: 'Copy reminder', clipboardHint: 'The mini program can remind you but cannot clear the clipboard automatically', storage: 'Storage usage', privacy: 'Privacy & permissions', policy: 'Privacy policy', policyHint: 'Learn about local encryption, backups, and data handling', permissions: 'Permissions', permissionsHint: 'Review camera, file, clipboard, and local-storage permissions', clear: 'Clear all local data', clearHint: 'Export a backup first. This cannot be undone.' },
  ja: { appearance: '表示', theme: 'テーマ', themeSystem: 'システムの外観に従う', themeLight: '常にライトモード', themeDark: '常にダークモード', language: '言語', languageHint: 'システムに従うか手動で選択できます', data: 'データ', trash: 'ゴミ箱の保持期間', history: '生成履歴の保存数', biometric: '生体認証ロック', biometricHint: '再度開くときに指紋または顔認証を使用します', clipboard: 'コピー後の通知', clipboardHint: 'クリップボードを自動消去できないため、通知のみ行います', storage: 'ストレージ使用量', privacy: 'プライバシーと権限', policy: 'プライバシーポリシー', policyHint: 'ローカル暗号化、バックアップ、データ処理について', permissions: '権限管理', permissionsHint: 'スキャン、ファイル、クリップボード、ローカル保存の権限を確認します', clear: 'すべてのローカルデータを消去', clearHint: '先にバックアップを作成してください。この操作は元に戻せません。' },
  'zh-Hant': { appearance: '外觀', theme: '主題模式', themeSystem: '跟隨系統深淺色', themeLight: '永遠使用淺色', themeDark: '永遠使用深色', language: '語言 / Language', languageHint: '可跟隨系統，也可手動選擇', data: '資料', trash: '垃圾桶保留時間', history: '產生歷史儲存數量', biometric: '生物辨識鎖定', biometricHint: '再次開啟小程式時使用指紋或臉部驗證', clipboard: '複製後提醒', clipboardHint: '小程式無法自動清空剪貼簿，只能提醒', storage: '儲存空間使用量', privacy: '隱私與權限', policy: '隱私協議', policyHint: '了解本機加密、備份和資料處理方式', permissions: '權限管理', permissionsHint: '查看掃碼、檔案、剪貼簿和本機儲存權限說明', clear: '清除全部本機資料', clearHint: '清除前請確認已匯出備份，此操作無法還原。' },
};

// 设置页有一部分是展开式表单，单独放在这里，避免主配置表过长又遗漏翻译。
const SETTINGS_DETAIL_COPY = {
  'zh-Hans': {
    pageTitle: '设置', backupProtect: '备份保护', createBackup: '创建备份密码', createBackupHint: '为之后导出的加密备份设置密码。换设备或清理微信数据后，需要它才能恢复。',
    backupPassword: '备份密码', passwordRules: '8–64 位；或选择下方空密码', useEmptyPassword: '使用空密码', useEmptyPasswordHint: '不设置备份密码；恢复时请保持密码为空', later: '稍后设置',
    changeBackup: '修改备份密码', backupCreated: '创建备份密码', backupChangeHint: '修改前需要验证当前密码', backupCreateHint: '用于加密备份；也可经确认后使用空密码', configured: '已设置', notConfigured: '未设置',
    currentBackup: '当前备份密码', currentBackupPlaceholder: '输入当前备份密码', newBackup: '新备份密码', confirmNewBackup: '确认新密码', confirmNewBackupPlaceholder: '再次输入以确认', emptyAfterChange: '改为空密码', emptyAfterChangeHint: '修改后，恢复备份时请保持密码为空',
    generate: '随机生成', generateNew: '生成新密码', createPassword: '创建密码', confirmChange: '确认修改', retentionWeek: '7 天', retentionMonth: '30 天', retentionQuarter: '90 天', retentionForever: '永久保留', history500: '最近 500 条', historyMonth: '最近一个月', storageCalculating: '计算中…', storageUnavailable: '无法读取', storageWarning: ' ⚠️ 接近上限',
  },
  en: {
    pageTitle: 'Settings', backupProtect: 'Backup protection', createBackup: 'Create backup password', createBackupHint: 'Set a password for encrypted backups. You will need it after changing devices or clearing WeChat data.',
    backupPassword: 'Backup password', passwordRules: '8–64 characters, or choose an empty password below', useEmptyPassword: 'Use empty password', useEmptyPasswordHint: 'No backup password. Leave it empty when restoring.', later: 'Set up later',
    changeBackup: 'Change backup password', backupCreated: 'Create backup password', backupChangeHint: 'Verify your current password before changing it', backupCreateHint: 'Encrypts backups; an empty password is available after confirmation', configured: 'Set', notConfigured: 'Not set',
    currentBackup: 'Current backup password', currentBackupPlaceholder: 'Enter current backup password', newBackup: 'New backup password', confirmNewBackup: 'Confirm new password', confirmNewBackupPlaceholder: 'Enter it again to confirm', emptyAfterChange: 'Change to empty password', emptyAfterChangeHint: 'Leave it empty when restoring after this change',
    generate: 'Generate', generateNew: 'Generate new password', createPassword: 'Create password', confirmChange: 'Confirm change', retentionWeek: '7 days', retentionMonth: '30 days', retentionQuarter: '90 days', retentionForever: 'Keep forever', history500: 'Latest 500', historyMonth: 'Last month', storageCalculating: 'Calculating…', storageUnavailable: 'Unavailable', storageWarning: ' ⚠️ Nearly full',
  },
  ja: {
    pageTitle: '設定', backupProtect: 'バックアップ保護', createBackup: 'バックアップパスワードを作成', createBackupHint: '暗号化バックアップ用のパスワードを設定します。端末変更や WeChat データ削除後の復元に必要です。',
    backupPassword: 'バックアップパスワード', passwordRules: '8～64 文字、または下で空のパスワードを選択', useEmptyPassword: '空のパスワードを使用', useEmptyPasswordHint: 'パスワードを設定しません。復元時も空欄にしてください。', later: 'あとで設定',
    changeBackup: 'バックアップパスワードを変更', backupCreated: 'バックアップパスワードを作成', backupChangeHint: '変更前に現在のパスワードを確認します', backupCreateHint: 'バックアップを暗号化します。確認後は空のパスワードも使えます', configured: '設定済み', notConfigured: '未設定',
    currentBackup: '現在のバックアップパスワード', currentBackupPlaceholder: '現在のパスワードを入力', newBackup: '新しいバックアップパスワード', confirmNewBackup: '新しいパスワードを確認', confirmNewBackupPlaceholder: '確認のためもう一度入力', emptyAfterChange: '空のパスワードに変更', emptyAfterChangeHint: '変更後の復元時は空欄にしてください',
    generate: 'ランダム生成', generateNew: '新しいパスワードを生成', createPassword: 'パスワードを作成', confirmChange: '変更を確認', retentionWeek: '7 日', retentionMonth: '30 日', retentionQuarter: '90 日', retentionForever: '無期限', history500: '最新 500 件', historyMonth: '直近 1 か月', storageCalculating: '計算中…', storageUnavailable: '読み取れません', storageWarning: ' ⚠️ 容量間近',
  },
  'zh-Hant': {
    pageTitle: '設定', backupProtect: '備份保護', createBackup: '建立備份密碼', createBackupHint: '為之後匯出的加密備份設定密碼。換裝置或清除微信資料後，需要它才能還原。',
    backupPassword: '備份密碼', passwordRules: '8–64 位；或選擇下方空密碼', useEmptyPassword: '使用空密碼', useEmptyPasswordHint: '不設定備份密碼；還原時請保持密碼為空', later: '稍後設定',
    changeBackup: '修改備份密碼', backupCreated: '建立備份密碼', backupChangeHint: '修改前需要驗證目前密碼', backupCreateHint: '用於加密備份；確認後也可使用空密碼', configured: '已設定', notConfigured: '未設定',
    currentBackup: '目前備份密碼', currentBackupPlaceholder: '輸入目前備份密碼', newBackup: '新備份密碼', confirmNewBackup: '確認新密碼', confirmNewBackupPlaceholder: '再次輸入以確認', emptyAfterChange: '改為空密碼', emptyAfterChangeHint: '修改後，還原備份時請保持密碼為空',
    generate: '隨機產生', generateNew: '產生新密碼', createPassword: '建立密碼', confirmChange: '確認修改', retentionWeek: '7 天', retentionMonth: '30 天', retentionQuarter: '90 天', retentionForever: '永久保留', history500: '最近 500 筆', historyMonth: '最近一個月', storageCalculating: '計算中…', storageUnavailable: '無法讀取', storageWarning: ' ⚠️ 接近上限',
  },
};

function otp(locale) {
  return OTP_COPY[resolveLocale(locale)] || OTP_COPY['zh-Hans'];
}
function home(locale) { return HOME_COPY[resolveLocale(locale)] || HOME_COPY['zh-Hans']; }
function settings(locale) {
  const resolved = resolveLocale(locale);
  return Object.assign({}, SETTINGS_COPY[resolved] || SETTINGS_COPY['zh-Hans'], SETTINGS_DETAIL_COPY[resolved] || SETTINGS_DETAIL_COPY['zh-Hans']);
}

module.exports = {
  SUPPORTED_LOCALES,
  LOCALE_OPTIONS,
  normalizeSystemLocale,
  getSystemLocale,
  resolveLocale,
  optionIndex,
  about,
  otp,
  home,
  settings,
};
