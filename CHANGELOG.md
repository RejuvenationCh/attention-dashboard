# Changelog

What changed in each version. The dashboard updates itself, so you get these automatically;
**Settings** shows which version you have.

## 1.10.0 (1 October 2026)

- **Its own app on Windows.** The installer adds **Attention Dashboard** to the Start menu and
  the desktop. It opens in its own window with its own icon, without browser tabs or an address
  bar, and you can pin it to the taskbar. Run `install.cmd` again to get the shortcuts.
- The dashboard now describes itself as an app, so Edge and Chrome can install it with its
  name and icon, and Safari's **Add to Dock** gets a sharp icon.

## 1.9.2 (1 October 2026)

- Windows: the installer could report "the server did not start" while it was running fine.
  The dashboard now answers on both of the computer's own addresses, so `localhost` connects
  straight away instead of after a two-second detour.
- Windows: `dashboard.log` is always written, including when the dashboard starts in the
  background at logon.
- The installers show numbered steps and say clearly when they are done.

## 1.9.1 (1 October 2026)

- Windows: double-click **install.cmd** to install (a .ps1 file opens in Notepad when
  double-clicked). **start.cmd** now says what it is doing, and if the background start fails it
  runs the dashboard in its own window and shows the error.
- Windows: the background start is simpler, and the dashboard keeps its own `dashboard.log`, so
  a failed start leaves a message.

## 1.9.0 (1 October 2026)

- **Bahasa Indonesia.** The whole dashboard, dates included, in Indonesian. It follows your
  browser's language; Settings → Appearance → Language to choose. Your own tasks, notes and
  calendar names are never translated. Reminder notifications follow the same language.
- Quick add understands Indonesian: `laporan besok jam 5 sore #kuliah`, `rapat senin 14.30`,
  `bayar kos setiap bulan 5 okt`, `presentasi lusa`, `minggu depan`, `dalam 3 hari`.

## 1.8.0 (1 October 2026)

- **Make it yours**, in Settings → Appearance:
  - **Show:** hide any of the clock tiles, the day ring, Course deadlines, Schedule, Search
    Calendar or Week Ahead.
  - **Clock:** 12-hour (5:30 PM) or 24-hour (17:30), everywhere on the page.
  - **Text size:** small, normal, large or larger.
  - **Compact spacing:** fits more on the screen.
- Fixed: the day dots on the schedule had a light ring in dark mode.

## 1.7.0 (1 October 2026)

- **Quick add.** Type one line at the top of Tasks, like `essay due fri 5pm #school !`, and press
  Enter. It understands dates (today, tomorrow, fri, 20/10, 5 oct, in 3 days), times, `#tags`,
  `!` for priority and "every week". Press Q to jump there.
- **Done tab.** Finished tasks move to their own tab, grouped by when you finished them, with a
  count for the week. The main list stays short.
- **Tags.** Add tags to a task (or `#tag` in quick add) and filter the list by one.
- **Steps.** A checklist inside a task: tick steps straight from the list. A repeating task
  starts its steps fresh each time.
- **Deadline events, your way.** Settings → Tasks: the title of the calendar event (with
  `{task}` and `{course}`), its length or all day, its colour, and whether your notes and links
  go in it.

## 1.6.0 (1 October 2026)

- **Safer updates.** If a new version ever fails to start, the dashboard goes back to the
  version you had within about two minutes, says so in Settings, and skips that version.
- **Daily backups.** A copy of your tasks, reminders and settings is saved every day; the last
  7 are kept. Settings → Your data → **Daily copies** opens the folder, and **Restore…** reads
  them.
- **Copy diagnostics** in Settings: a short report to paste to whoever is helping you, with
  email addresses and passwords blanked out.

## 1.5.0 (1 October 2026)

- **Dark mode.** Settings → Appearance: follow your computer, or pick Light or Dark. You can
  also pick an accent colour.
- **Reduce effects** in the same place turns off the glass blur and animations, for older or
  slower computers.
- **Get started** card on a new install: connect Google, add your name, add your eLearn link.
- **Backup and restore** in Settings → Your data: your tasks, reminders, course names and
  settings in one file, for moving to a new computer.
- **Keyboard shortcuts**: N new task, / search tasks, T today, M month, R refresh, comma for
  Settings. Press ? for the list.
- After an update, a card shows what changed, once.
- Settings is grouped into sections.
- Faster: the icon font is 20 KB instead of 2.3 MB, and each refresh asks Google for your
  calendars once instead of twice.
- macOS: the Browse folder picker opens in a fraction of a second instead of about two.
- Fixed: changing the eLearn link in Settings could list your accounts twice.

## 1.4.2 (1 October 2026)

- Settings no longer shows an **Install** button when you already have the latest version.

## 1.4.1 (30 September 2026)

- eLearn courses no longer carry a "Class" tag in the Accounts card. Calendar types are for
  your Google calendars.

## 1.4.0 (30 September 2026)

- **Check for updates** now only checks. When there is a new version, Settings says so, shows
  what's new in it, and offers an **Install** button.
- New **Automatic updates** switch in Settings, on by default. Turn it off to choose when to
  install; the dashboard still checks every hour and tells you when a new version is out.

## 1.3.1 (30 September 2026)

- Friendlier wording for people who don't use a calendar much: "Upcoming Schedule" is now
  **Schedule**, "Find an Event" is now **Search Calendar**, and empty days and the "not
  connected" messages no longer assume you have events.
- The "Dashboard stopped" page no longer keeps running the clock in the background.

## 1.3.0 (30 September 2026)

- **Check for updates** in Settings installs a new version straight away and reloads the page.
- **Stop dashboard** in Settings shuts it down until you next log in. Double-click
  `start.command` (macOS) or `start.cmd` (Windows) in the folder to start it sooner.
- Updates are checked every hour instead of every six.
- macOS: if you installed before this version, run `./install.sh` once more so that Stop
  dashboard stays stopped.

## 1.2.0 (30 September 2026)

- **Calendar types.** Mark each calendar as Class, Work, Personal, Family or Other in the
  Accounts card, and filter **Find an Event** by type. eLearn courses start as Class.
- Without a Google account, Find an Event now says so instead of loading forever.
- Without a Google account, "Add deadline reminder to Google Calendar" is switched off and
  says why, instead of failing when you save.
- If adding a reminder to Google Calendar fails, you now see a message. It used to be hidden
  behind the closing window.

## 1.1.1 (30 September 2026)

- Clearer wording throughout the app.
- New deadline reminders in Google Calendar are titled "Deadline: …". Ones added by earlier
  versions are still recognised, so nothing is added twice.

## 1.1.0 (30 September 2026)

- **Windows support**: installer, folder picker, Explorer links and notifications. Not yet
  tested much on real Windows machines.
- The dashboard can now only be opened from your own computer, never from other devices on
  the same network. This protects your Google sign-ins on shared Wi-Fi.
- Folder names with non-English characters are handled correctly on Windows.

## 1.0.0 (30 September 2026)

First shareable version.

- Installers for macOS and Windows, which start the dashboard at every login.
- Connect your own Google accounts, with no Google Cloud setup of your own.
- Your name and eLearn link are set in **Settings**.
- Times follow your computer's time zone. eLearn deadlines keep eLearn's own clock.
- Updates install themselves.
