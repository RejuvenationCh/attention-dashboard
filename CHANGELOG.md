# Changelog

What changed in each version. The dashboard updates itself, so you get these automatically;
**Settings** shows which version you have.

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
