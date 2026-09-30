// Run: node test-quickadd.js   (part of npm test)
const assert = require('assert');
const { parseQuickAdd } = require('./public/quickadd.js');

const today = new Date(2026, 9, 1);   // Thursday 1 October 2026
const p = s => parseQuickAdd(s, today);
const check = (input, expected) => {
  const got = p(input);
  for (const [k, v] of Object.entries(expected)) assert.deepStrictEqual(got[k], v, `${input} → ${k}: ${JSON.stringify(got[k])}`);
};

check('essay due fri 5pm #school !', { title: 'essay', deadline: '2026-10-02', time: '17:00', tags: ['school'], priority: true });
check('Buy cables', { title: 'Buy cables', deadline: null, time: null, tags: [], priority: false, repeat: null });
check('call mum tomorrow', { title: 'call mum', deadline: '2026-10-02' });
check('report today at 17:30', { title: 'report', deadline: '2026-10-01', time: '17:30' });
check('thu review', { title: 'review', deadline: '2026-10-08' });              // today is Thursday: next one
check('pay rent 5 oct', { title: 'pay rent', deadline: '2026-10-05' });
check('pay rent oct 5', { title: 'pay rent', deadline: '2026-10-05' });
check('dentist 20/10', { title: 'dentist', deadline: '2026-10-20' });
check('exam 3/1', { title: 'exam', deadline: '2027-01-03' });                   // already past this year
check('exam 12/1/2026', { title: 'exam', deadline: '2026-01-12' });
check('gym in 3 days', { title: 'gym', deadline: '2026-10-04' });
check('standup every week next week', { title: 'standup', repeat: 'weekly', deadline: '2026-10-08' });
check('invoice monthly #work #money', { title: 'invoice', repeat: 'monthly', tags: ['work', 'money'] });
check('ship 9.30am', { title: 'ship', time: '09:30' });
check('Chapter 3 notes', { title: 'Chapter 3 notes', deadline: null });         // a lone number is not a date
check('may the force wednesday', { title: 'may the force', deadline: '2026-10-07' });
check('32/13 nothing', { deadline: null });
// Bahasa Indonesia
check('laporan besok jam 5 sore #kuliah', { title: 'laporan', deadline: '2026-10-02', time: '17:00', tags: ['kuliah'] });
check('rapat hari ini jam 14.30', { title: 'rapat', deadline: '2026-10-01', time: '14:30' });
check('kumpul tugas jumat', { title: 'kumpul tugas', deadline: '2026-10-02' });
check('ibadah minggu jam 7 pagi', { title: 'ibadah', deadline: '2026-10-04', time: '07:00' });
check('review minggu depan', { title: 'review', deadline: '2026-10-08' });
check('bayar kos setiap bulan 5 okt', { title: 'bayar kos', repeat: 'monthly', deadline: '2026-10-05' });
check('olahraga setiap minggu', { title: 'olahraga', repeat: 'weekly', deadline: null });
check('ujian 3 des', { title: 'ujian', deadline: '2026-12-03' });
check('presentasi lusa', { title: 'presentasi', deadline: '2026-10-03' });
check('baca bab 3 dalam 4 hari', { title: 'baca bab 3', deadline: '2026-10-05' });
check('makan malam jam 7 malam', { title: 'makan malam', time: '19:00' });
console.log('quick add ok');
