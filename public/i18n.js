// Bahasa Indonesia. Rather than threading a t() through every string in app.js, this translates
// the page as it is drawn: exact phrases from the dictionary, and patterns for phrases with a
// number or name in them. Text inside the user's own content (task titles, notes, event titles,
// calendar and course names) is never touched, even when it happens to match a phrase.
// Language: Settings → Appearance → Language; "Automatic" follows the browser.
(() => {
  const pref = (() => { try { return JSON.parse(localStorage.getItem('attention-appearance-v1'))?.lang || 'auto'; } catch { return 'auto'; } })();
  const browserId = (navigator.languages || [navigator.language]).some(l => /^id\b|^in\b/i.test(l || ''));
  const lang = pref === 'id' || (pref === 'auto' && browserId) ? 'id' : 'en';
  document.documentElement.lang = lang;
  window.i18n = { lang, dateLocale: lang === 'id' ? 'id-ID' : 'en-ID' };
  if (lang !== 'id') return;

  const D = {
    // Header, cards, common
    'Attention': 'Attention', 'Today': 'Hari ini', 'Tomorrow': 'Besok', 'Month': 'Bulan', 'Refreshed': 'Diperbarui',
    'Notifications': 'Notifikasi', 'Settings': 'Pengaturan', 'Refresh': 'Muat ulang', 'Reload': 'Muat ulang',
    'Mark all read': 'Tandai semua dibaca', 'Clear read': 'Hapus yang dibaca', 'Dismiss': 'Tutup',
    'Attention Dashboard': 'Attention Dashboard', 'Hello.': 'Halo.', 'Live Time': 'Waktu', 'Next Up': 'Berikutnya',
    'of day': 'hari ini', 'Tasks': 'Tugas', 'To do': 'Belum', 'Done': 'Selesai', 'New Task': 'Tugas Baru', 'Add task': 'Tambah tugas',
    'Search tasks…': 'Cari tugas…', 'Search tasks': 'Cari tugas', 'Sort tasks': 'Urutkan tugas', 'Manual order': 'Urutan manual',
    'By deadline': 'Menurut tenggat', 'By priority': 'Menurut prioritas', 'Remind me about tasks that are due': 'Ingatkan saya tentang tugas yang jatuh tempo',
    'Quick add: essay due fri 5pm #school !': 'Tambah cepat: esai besok jam 17.00 #kuliah !',
    'Course Deadlines': 'Tenggat Kuliah', 'Course deadlines': 'Tenggat kuliah', 'Accounts': 'Akun', 'Add account': 'Tambah akun',
    'Schedule': 'Jadwal', 'Search Calendar': 'Cari Kalender', 'Search your calendar…': 'Cari di kalender…',
    'Which calendars this list shows': 'Kalender yang ditampilkan daftar ini', 'How far ahead': 'Seberapa jauh ke depan',
    '7 days': '7 hari', '30 days': '30 hari', '90 days': '90 hari', 'Week Ahead': 'Minggu Depan', 'Pending Invitations': 'Undangan Tertunda',
    'Back to top': 'Kembali ke atas', 'Month View': 'Tampilan Bulan', 'Compact': 'Ringkas', 'Expanded': 'Lengkap',
    'Task removed': 'Tugas dihapus', 'Undo': 'Urungkan', 'Cancel': 'Batal', 'Add': 'Tambah', 'Edit': 'Ubah', 'Remove': 'Hapus',
    'Delete': 'Hapus', 'Snooze': 'Tunda', 'Snooze until': 'Tunda sampai', 'Mark done': 'Tandai selesai', 'Reopen': 'Buka lagi',
    'Bring back now': 'Kembalikan sekarang', 'Mark as priority': 'Tandai prioritas', 'Not a priority': 'Bukan prioritas',
    'Open folder': 'Buka folder', 'Open link': 'Buka tautan', 'Browse': 'Pilih', 'All': 'Semua', 'All calendars': 'Semua kalender',
    'Calendars': 'Kalender', 'Select all': 'Pilih semua', 'Clear all': 'Hapus semua', 'Show all': 'Tampilkan semua',
    'Snoozed': 'Ditunda', 'Completed': 'Selesai', 'No tasks': 'Tidak ada tugas', 'No deadline': 'Tanpa tenggat',
    'Due today': 'Jatuh tempo hari ini', 'Due today!': 'Jatuh tempo hari ini!', 'on calendar': 'di kalender',
    'weekly': 'mingguan', 'monthly': 'bulanan', 'Nothing scheduled': 'Tidak ada jadwal', 'Nothing scheduled.': 'Tidak ada jadwal.',
    'Nothing upcoming': 'Tidak ada yang akan datang', "you're all clear": 'semua beres', 'Nothing matches that.': 'Tidak ada yang cocok.',
    'Nothing matches.': 'Tidak ada yang cocok.', 'Every calendar is switched off.': 'Semua kalender dimatikan.',
    'Nothing due from your courses.': 'Tidak ada tenggat dari mata kuliah.', 'All day': 'Sepanjang hari', 'all day': 'sepanjang hari',
    'Nothing finished yet. Ticked-off tasks land here.': 'Belum ada yang selesai. Tugas yang dicentang muncul di sini.',
    'Yesterday': 'Kemarin', 'This week': 'Minggu ini', 'Last week': 'Minggu lalu', 'Earlier': 'Sebelumnya',
    'Connect Google Calendar': 'Hubungkan Google Kalender', 'Connect': 'Hubungkan', 'Reconnect': 'Hubungkan lagi',
    'Connect Google Calendar to see your schedule here': 'Hubungkan Google Kalender untuk melihat jadwalmu di sini',
    'Connect Google Calendar to search it here': 'Hubungkan Google Kalender untuk mencarinya di sini',
    'No calendar yet': 'Belum ada kalender', 'No account connected yet.': 'Belum ada akun terhubung.',
    'Signed out, so its calendars are not loading': 'Keluar, jadi kalendernya tidak dimuat',
    'Signed out. Reconnect your Google account in Accounts': 'Keluar. Hubungkan lagi akun Google di Akun',
    'Blocks your free time. Click to ignore': 'Menghalangi waktu luangmu. Klik untuk mengabaikan',
    'Ignored when working out free time': 'Diabaikan saat menghitung waktu luang', 'Rename': 'Ganti nama', 'Disconnect': 'Putuskan',
    '+ Type': '+ Jenis', 'No type': 'Tanpa jenis', 'Class': 'Kuliah', 'Work': 'Kerja', 'Personal': 'Pribadi', 'Family': 'Keluarga', 'Other': 'Lainnya',
    'Delete from Google Calendar': 'Hapus dari Google Kalender', 'Accepted': 'Diterima', 'Declined': 'Ditolak',
    'Get started': 'Mulai', 'Hide': 'Sembunyikan', 'Got it': 'Mengerti', 'Add your name': 'Tambahkan namamu',
    'Your events and free time, and reminders for deadlines.': 'Acara dan waktu luangmu, dan pengingat tenggat.',
    'For the greeting.': 'Untuk sapaan.', 'Add your eLearn calendar (optional)': 'Tambahkan kalender eLearn (opsional)',
    'Course deadlines, soonest first.': 'Tenggat kuliah, yang terdekat dulu.',
    // Task window
    'Task': 'Tugas', 'What needs to be done?': 'Apa yang perlu dikerjakan?', 'Description (optional)': 'Deskripsi (opsional)',
    'Any notes or context…': 'Catatan atau konteks…', 'Steps (optional)': 'Langkah (opsional)', 'Add a step, then Enter': 'Tambah langkah, lalu Enter',
    'Remove step': 'Hapus langkah', 'Tags (optional)': 'Tag (opsional)', 'school, urgent': 'kuliah, penting',
    'Links or folders (optional)': 'Tautan atau folder (opsional)', 'Add another link': 'Tambah tautan lain', 'Name (optional)': 'Nama (opsional)',
    'Deadline (optional)': 'Tenggat (opsional)', 'Day, e.g. 20 · or 20/9 · or 20/9/2026': 'Tanggal, mis. 20 · atau 20/9 · atau 20/9/2026',
    'Repeats': 'Berulang', 'Never': 'Tidak', 'Every week': 'Setiap minggu', 'Every month': 'Setiap bulan',
    'Course deadline (optional)': 'Tenggat kuliah (opsional)', 'None': 'Tidak ada',
    'Add deadline reminder to Google Calendar': 'Tambahkan pengingat tenggat ke Google Kalender',
    'Connect a Google account to add deadline reminders': 'Hubungkan akun Google untuk menambahkan pengingat tenggat',
    'Save Task': 'Simpan Tugas', 'Update Task': 'Perbarui Tugas', 'Edit Task': 'Ubah Tugas', 'Saving…': 'Menyimpan…', 'Choosing…': 'Memilih…',
    'Please enter a task title.': 'Tulis judul tugas.', 'The deadline is not a date. Try 20, 20/9 or 20/9/2026.': 'Tenggat bukan tanggal. Coba 20, 20/9 atau 20/9/2026.',
    'Could not open the folder picker.': 'Pemilih folder tidak bisa dibuka.',
    // Keyboard shortcuts
    'Keyboard shortcuts': 'Pintasan keyboard', 'New task': 'Tugas baru', 'Quick add': 'Tambah cepat', 'Month view': 'Tampilan bulan',
    'This list': 'Daftar ini', 'Close whatever is open': 'Tutup yang sedang terbuka',
    // Settings
    'You': 'Kamu', 'Your name': 'Namamu', 'eLearn calendar': 'Kalender eLearn',
    'Moodle → Calendar → Export calendar → Get URL for subscription. Paste the whole URL; it stays on this computer.': 'Moodle → Kalender → Ekspor kalender → Dapatkan URL langganan. Tempel URL lengkapnya; tetap di komputer ini.',
    'Connected (paste to replace)': 'Terhubung (tempel untuk mengganti)',
    'Remind me': 'Ingatkan saya', 'Days before a deadline to be notified. 0 means only once it is due.': 'Berapa hari sebelum tenggat untuk diberi tahu. 0 berarti saat jatuh tempo.',
    'Snooze lengths': 'Lama penundaan', 'Days, comma separated. These become the snooze buttons.': 'Hari, dipisah koma. Ini menjadi tombol tunda.',
    'Default task sort': 'Urutan tugas bawaan', 'What the list falls back to on a fresh visit.': 'Urutan daftar saat pertama dibuka.',
    'New task defaults': 'Bawaan tugas baru', 'What the New Task window starts with. Each one can still be changed per task.': 'Isi awal jendela Tugas Baru. Tetap bisa diubah per tugas.',
    'Add deadline to Google Calendar': 'Tambahkan tenggat ke Google Kalender', 'Deadline': 'Tenggat', 'Empty': 'Kosong', 'In a week': 'Seminggu lagi',
    'New course deadlines': 'Tenggat kuliah baru', 'Turn a newly posted eLearn deadline into a task automatically.': 'Jadikan tenggat eLearn baru sebagai tugas secara otomatis.',
    'Deadline time': 'Jam tenggat', 'For a task with only a date. A course deadline uses its own due time from eLearn.': 'Untuk tugas yang hanya punya tanggal. Tenggat kuliah memakai jamnya sendiri dari eLearn.',
    'At the time': 'Tepat waktunya', '30 min before': '30 menit sebelumnya', '1 hour before': '1 jam sebelumnya', '3 hours before': '3 jam sebelumnya',
    '1 day before': '1 hari sebelumnya', '2 days before': '2 hari sebelumnya',
    'Deadline event title': 'Judul acara tenggat', 'What the calendar event is called. {task} is the task, {course} the course. Now:': 'Nama acara di kalender. {task} adalah tugas, {course} mata kuliah. Sekarang:',
    'Deadline event look': 'Tampilan acara tenggat', 'How long the event is, and its colour on the calendar.': 'Lama acara dan warnanya di kalender.',
    '15 min': '15 menit', '30 min': '30 menit', '1 hour': '1 jam', '2 hours': '2 jam', "Calendar's colour": 'Warna kalender',
    'Lavender': 'Lavender', 'Sage': 'Hijau sage', 'Grape': 'Anggur', 'Flamingo': 'Flamingo', 'Banana': 'Pisang', 'Tangerine': 'Jeruk',
    'Peacock': 'Biru merak', 'Graphite': 'Grafit', 'Blueberry': 'Blueberry', 'Basil': 'Kemangi', 'Tomato': 'Tomat',
    'Deadline event details': 'Detail acara tenggat', "Put the task's notes and links in the event, so they are there on your phone too.": 'Masukkan catatan dan tautan tugas ke acara, agar ada juga di ponselmu.',
    'Calendar': 'Kalender', 'Week starts on': 'Minggu dimulai', 'Sets the month grid\'s columns.': 'Mengatur kolom kalender bulan.',
    'Monday': 'Senin', 'Sunday': 'Minggu', 'Day window': 'Rentang hari', 'Day progress hours': 'Jam progres hari',
    'The ring next to the greeting fills up between these hours. Set them to your own day, e.g. 8 to 23.': 'Lingkaran di samping sapaan terisi di antara jam ini. Sesuaikan dengan harimu, mis. 8 sampai 23.', 'What the progress ring measures, between these hours.': 'Yang diukur lingkaran progres, di antara jam ini.',
    'to': 'sampai', 'Deadline calendar': 'Kalender tenggat', 'Where "Add deadline reminder to Google Calendar" writes.': 'Tempat "Tambahkan pengingat tenggat ke Google Kalender" menulis.',
    'Default (first account)': 'Bawaan (akun pertama)', 'Now line': 'Garis sekarang',
    'The line marking the current time across an event you are in. 0 hides it.': 'Garis penanda waktu sekarang pada acara yang sedang berlangsung. 0 menyembunyikannya.',
    'Day reminders': 'Pengingat harian', 'Shown at the top of the page on that day, e.g. every Wednesday: wear batik.': 'Tampil di atas halaman pada hari itu, mis. setiap Rabu: pakai batik.',
    'Sent as a notification at': 'Dikirim sebagai notifikasi pukul', "o'clock, and shown at the top of the page all day.": ', dan tampil di atas halaman sepanjang hari.',
    'No reminders yet.': 'Belum ada pengingat.', 'Every Monday': 'Setiap Senin', 'Every Tuesday': 'Setiap Selasa', 'Every Wednesday': 'Setiap Rabu',
    'Every Thursday': 'Setiap Kamis', 'Every Friday': 'Setiap Jumat', 'Every Saturday': 'Setiap Sabtu', 'Every Sunday': 'Setiap Minggu',
    'On a date…': 'Pada tanggal…', 'Wear batik': 'Pakai batik', 'Delete reminder': 'Hapus pengingat', 'Pick a date for the reminder': 'Pilih tanggal untuk pengingat',
    'Appearance': 'Tampilan', 'Theme': 'Tema', "System follows your computer's light or dark setting.": 'Sistem mengikuti mode terang atau gelap komputermu.',
    'System': 'Sistem', 'Light': 'Terang', 'Dark': 'Gelap', 'Accent colour': 'Warna aksen', 'Buttons, links and highlights.': 'Tombol, tautan dan sorotan.',
    'Blue': 'Biru', 'Teal': 'Hijau toska', 'Purple': 'Ungu', 'Rose': 'Merah muda', 'Amber': 'Kuning tua', 'Custom…': 'Pilih sendiri…',
    'Custom colour': 'Warna sendiri', 'Pick one, or type a hex code like #e11d48.': 'Pilih warna, atau ketik kode hex seperti #e11d48.',
    'Language': 'Bahasa', 'Automatic follows your browser.': 'Otomatis mengikuti browser.', 'Automatic': 'Otomatis',
    'Text size': 'Ukuran teks', 'Everything on the page grows or shrinks with it.': 'Seluruh halaman ikut membesar atau mengecil.',
    'Small': 'Kecil', 'Normal': 'Normal', 'Large': 'Besar', 'Larger': 'Lebih besar', 'Compact spacing': 'Jarak rapat',
    'Less space between cards and tasks, so more fits on screen.': 'Jarak lebih rapat antarkartu dan tugas, agar lebih banyak yang muat.',
    'Clock': 'Jam', 'How times are written everywhere on the page.': 'Cara penulisan jam di seluruh halaman.',
    '24-hour (17:30)': '24 jam (17:30)', '12-hour (5:30 PM)': '12 jam (5:30 PM)', 'Show': 'Tampilkan',
    'Cards to keep on the dashboard. Tasks and Accounts always stay.': 'Kartu yang tampil di dasbor. Tugas dan Akun selalu tampil.',
    'Clock and Next up': 'Jam dan Berikutnya', 'Day progress ring': 'Lingkaran progres hari',
    'Reduce effects': 'Kurangi efek', 'Turns off the glass blur and animations. Faster on older computers.': 'Mematikan efek kaca buram dan animasi. Lebih cepat di komputer lama.',
    'Your data': 'Datamu', 'Backup': 'Cadangan', 'Download': 'Unduh', 'Restore…': 'Pulihkan…', 'Daily copies': 'Salinan harian',
    'Your tasks, reminders, course names and settings in one file. Google sign-ins and the eLearn link are left out, so you reconnect those after restoring. A copy is also saved automatically every day; the last 7 are kept.': 'Tugas, pengingat, nama mata kuliah dan pengaturanmu dalam satu file. Login Google dan tautan eLearn tidak ikut, jadi hubungkan lagi setelah memulihkan. Salinan juga disimpan otomatis setiap hari; 7 terakhir disimpan.',
    'App': 'Aplikasi', 'Automatic updates': 'Pembaruan otomatis', 'Checks every hour. When off, new versions are shown here to install yourself.': 'Memeriksa setiap jam. Jika mati, versi baru ditampilkan di sini untuk dipasang sendiri.',
    'Check for updates': 'Periksa pembaruan', 'Checking…': 'Memeriksa…', 'Installing…': 'Memasang…', 'Stop dashboard': 'Hentikan dasbor',
    'Copy diagnostics': 'Salin diagnostik', 'Reset to defaults': 'Kembalikan ke bawaan', 'Settings saved': 'Pengaturan disimpan',
    'Dashboard stopped': 'Dasbor dihentikan', 'Reminders muted': 'Pengingat dimatikan', 'Reminders on. Click to mute': 'Pengingat aktif. Klik untuk mematikan',
    'Removed from calendar': 'Dihapus dari kalender', 'That deadline is already on your calendar': 'Tenggat itu sudah ada di kalendermu',
    'Connect a Google account first, then add deadlines to its calendar': 'Hubungkan akun Google dulu, lalu tambahkan tenggat ke kalendernya',
    'Type what the task is, then Enter.': 'Tulis tugasnya, lalu Enter.', 'That file is not a backup.': 'File itu bukan cadangan.',
    'That file is not an Attention Dashboard backup.': 'File itu bukan cadangan Attention Dashboard.',
    'Diagnostics copied. Paste them in a message to whoever is helping you.': 'Diagnostik disalin. Tempelkan dalam pesan ke orang yang membantumu.',
    'The update is taking a while. Reload the page in a minute.': 'Pembaruan agak lama. Muat ulang halaman sebentar lagi.',
    'Nothing new. Added, moved and removed events show up here.': 'Belum ada yang baru. Acara yang ditambah, dipindah, dan dihapus muncul di sini.',
    'Join Meet': 'Gabung Meet', '(No title)': '(Tanpa judul)', 'Hide dates': 'Sembunyikan tanggal',
  };
  const DAY = { Morning: 'pagi', Afternoon: 'siang', Evening: 'malam' };
  const P = [
    [/^Good (Morning|Afternoon|Evening)(, .+)?\.$/, (m, p, n) => `Selamat ${DAY[p]}${n || ''}.`],
    [/^(\d+) days? left$/, '$1 hari lagi'], [/^Overdue by (\d+) days?$/, 'Terlambat $1 hari'],
    [/^Due in (\d+) days?$/, 'Jatuh tempo $1 hari lagi'], [/^(\d+) days? ago$/, '$1 hari lalu'],
    [/^Completed today$/, 'Selesai hari ini'], [/^Completed yesterday$/, 'Selesai kemarin'], [/^Completed (\d+) days ago$/, 'Selesai $1 hari lalu'],
    [/^(\d+)\/(\d+) steps$/, '$1/$2 langkah'], [/^(\d+) steps$/, '$1 langkah'], [/^Done (\d+)$/, 'Selesai $1'],
    [/^(\d+) finished in the last 7 days$/, '$1 selesai dalam 7 hari terakhir'],
    [/^Hidden until (.+)$/, 'Disembunyikan sampai $1'], [/^(\d+) days?$/, '$1 hari'],
    [/^(\d+) events?$/, '$1 acara'], [/^(\d+) due today$/, '$1 jatuh tempo hari ini'], [/^(\d+) overdue$/, '$1 terlambat'], [/^NOW (.+)$/, 'SEKARANG $1'], [/^Day progress, (.+) to (.+)\. Click to change the hours\.$/, 'Progres hari, $1 sampai $2. Klik untuk mengubah jamnya.'], [/^on now$/, 'sedang berlangsung'], [/^until (.+)$/, 'sampai $1'],
    [/^(\d+h(?: \d+m)?|\d+m) free$/, (m, d) => 'kosong ' + d.replace('h', 'j')],
    [/^Version (\S+)\. Up to date\.$/, 'Versi $1. Sudah terbaru.'], [/^Version (\S+)\. Version (\S+) is available\.$/, 'Versi $1. Versi $2 tersedia.'],
    [/^Version (\S+)\. Automatic updates are off\.$/, 'Versi $1. Pembaruan otomatis mati.'], [/^Version (\S+)\. Not a git clone, so updates are manual\.$/, 'Versi $1. Bukan salinan git, jadi pembaruan harus manual.'],
    [/^Version (\S+)\. Version (\S+) is out, but local edits to the app's files block the update\.$/, 'Versi $1. Versi $2 sudah ada, tapi perubahan lokal pada file aplikasi menghalangi pembaruan.'],
    [/^Version (\S+)\.$/, 'Versi $1.'],
    [/^Version (\S+)\. Version (\S+) did not start, so the dashboard went back to (\S+)\. It will wait for the next version\.$/,
      'Versi $1. Versi $2 gagal berjalan, jadi dasbor kembali ke $3. Dasbor akan menunggu versi berikutnya.'],
    [/^Install (\S+)$/, 'Pasang $1'], [/^Updated to version (\S+)$/, 'Diperbarui ke versi $1'], [/^What's new in (.+)$/, 'Yang baru di $1'],
    [/^You have the latest version \((\S+)\)$/, 'Kamu sudah memakai versi terbaru ($1)'],
    [/^"(.+)" completed$/, '"$1" selesai'], [/^"(.+)" reopened$/, '"$1" dibuka lagi'], [/^"(.+)" removed$/, '"$1" dihapus'],
    [/^"(.+)" done\. Next one on (.+)$/, '"$1" selesai. Berikutnya $2'], [/^"(.+)" back on (.+)$/, '"$1" kembali pada $2'],
    [/^Added "(.+)", due (.+)$/, 'Ditambahkan "$1", tenggat $2'], [/^Added "(.+)"$/, 'Ditambahkan "$1"'],
    [/^Added "(.+)" to your calendar$/, '"$1" ditambahkan ke kalendermu'],
    [/^Nothing matches “(.+)”\.$/, 'Tidak ada yang cocok dengan “$1”.'],
    [/^(\d+) of (\d+) calendars? failed to load$/, '$1 dari $2 kalender gagal dimuat'],
    [/^Backup saved: (\d+) tasks?$/, 'Cadangan disimpan: $1 tugas'],
    [/^Could not (.+?): (.+)$/, (m, what, why) => `Tidak bisa ${({ save: 'menyimpan', install: 'memasang', restore: 'memulihkan',
      'check for updates': 'memeriksa pembaruan', 'make a backup': 'membuat cadangan', 'collect diagnostics': 'mengumpulkan diagnostik',
      'change reminders': 'mengubah pengingat', 'stop it': 'menghentikannya', 'load your calendar': 'memuat kalendermu',
      'rename': 'mengganti nama' })[what] || what}: ${why}`],
  ];

  // The user's own words live inside these; they are never translated.
  const SKIP = '.task-title, .task-desc, .task-link, .task-tag, .task-step, .step-row, .cal-name, .acct-email, .notif-title, '
    + '.notif-detail, .invite-title, .invite-meta, .dr-text, .tl-title a, .week-ev .t, .mev, .course-tag, .day-chip, '
    + '#cd-name, #greet-line .name, .welcome-notes, .update-notes li, input, textarea, script, style';
  const one = s => {
    const key = s.trim();
    if (!key) return s;
    if (D[key] !== undefined) return s.replace(key, D[key]);
    for (const [re, to] of P) if (re.test(key)) return s.replace(key, key.replace(re, to));
    return s;
  };
  // Mixed lines ("15 days left · 1/3 steps") are translated a piece at a time.
  const line = s => s.includes(' · ') ? s.split(/( · )/).map(p => (p === ' · ' ? p : one(p))).join('') : one(s);
  function translate(root) {
    if (root.nodeType === 3) {
      if (!root.parentElement?.closest(SKIP)) { const t = line(root.nodeValue); if (t !== root.nodeValue) root.nodeValue = t; }
      return;
    }
    if (root.nodeType !== 1 || root.closest(SKIP.replace(/, input, textarea/, ''))) return;
    for (const el of [root, ...root.querySelectorAll('[placeholder], [title]')]) {
      if (el.closest?.('.task-row .task-main, .tl-title a')) continue;
      for (const attr of ['placeholder', 'title']) {
        const v = el.getAttribute?.(attr);
        if (v) { const t = line(v); if (t !== v) el.setAttribute(attr, t); }
      }
    }
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) translate(n);
  }
  window.i18n.t = line;
  document.addEventListener('DOMContentLoaded', () => {
    translate(document.body);
    // Placeholders and tooltips set later from script (not as new nodes) are caught as attributes.
    new MutationObserver(list => {
      for (const m of list) {
        if (m.type === 'characterData') translate(m.target);
        else if (m.type === 'attributes') {
          const v = m.target.getAttribute(m.attributeName);
          if (v && !m.target.closest('.task-row .task-main, .tl-title a')) { const t = line(v); if (t !== v) m.target.setAttribute(m.attributeName, t); }
        }
        else m.addedNodes.forEach(translate);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title'] });
  });
})();
