# A quick-capture panel on a hotkey (the F3 thing)

How the dashboard's F3 add-task box works, written so it can be lifted into another project —
e.g. F4 for Finance. Hammerspoon opens a borderless floating window; everything inside it is an
ordinary page served by that project's own server, so it shares the CSS and posts to the same API.

Two pieces: a page in the project, and ~40 lines of Lua in `~/.hammerspoon/init.lua`.

Placeholders: `<name>` (e.g. `finance`), `<Port>` (e.g. `3200`), `<page>` (e.g. `add-entry.html`),
`<Key>` (e.g. `f4`), `<Handler>` — the message-port name, any unique string, e.g. `financePrompt`.

## 1. The page

Put it beside the app's other static files so it is same-origin: `public/<page>`. Keep it to a
single card — it *is* the window, so no page background, no scrolling.

It cannot close its own window, so it asks Lua to:

```js
function closeWindow() {
  try { window.webkit.messageHandlers.<Handler>.postMessage({ action: 'close' }); } catch (e) {}
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWindow(); });
```

Call `closeWindow()` from Cancel, from the X, and after a successful save. Wrap it in try/catch:
in a normal browser tab `window.webkit` is undefined, and you still want the page to work there.

## 2. The Lua

```lua
local APP     = "http://localhost:<Port>"
local KEY     = hs.keycodes.map["<Key>"]

-- Globals, not locals: if you rebuild the event tap periodically, state shared with it must
-- outlive one build of it.
<name>Window = nil
<name>Held   = false            -- auto-repeat sends keyDown with no keyUp; without this, holding
                                -- the key toggles the panel dozens of times a second

local function close<Name>Panel()
    if not <name>Window then return end
    local w = <name>Window
    <name>Window = nil          -- nil'd first: delete() fires "closing", which must find nothing to do
    w:delete()
end

-- The callback gets an ENVELOPE, not what the page posted: { body = <your object>, name = …,
-- frameInfo = …, webView = … }. Reading msg.action is the obvious thing to write and it never
-- matches, so Cancel looks dead. The payload is one level down, at msg.body.
local content = hs.webview.usercontent.new("<Handler>")
content:setCallback(function(msg)
    if type(msg) == "table" and type(msg.body) == "table" and msg.body.action == "close" then
        close<Name>Panel()
    end
end)

local function open<Name>Panel()
    if <name>Window then <name>Window:bringToFront(false) return end

    -- frame() is the screen minus menu bar and Dock. hs.screen has no visibleFrame — calling it
    -- throws, the pcall below swallows it, and the key just does nothing.
    local f = (hs.mouse.getCurrentScreen() or hs.screen.mainScreen()):frame()
    -- Measure these against the real page at that width. WebKit and Chromium differ by a couple
    -- of px per form control, and hs.webview draws with WebKit — so measure in the panel itself.
    local w, h = 520, 491

    -- The user-content controller is the THIRD argument. Passing nil for the prefs table is not
    -- a way to skip it: the arguments shift and the constructor throws.
    <name>Window = hs.webview.new(
        { x = f.x + (f.w - w) / 2, y = f.y + f.h - h, w = w, h = h },   -- flush with the bottom
        {}, content)
    -- No windowStyle call on purpose: hs.webview.new is already borderless. Asking for "titled"
    -- puts a macOS title bar above your card.
    <name>Window:level(hs.canvas.windowLevels.floating)
    <name>Window:allowTextEntry(true)      -- without this, fields take no keyboard input at all
    <name>Window:deleteOnClose(true)
    <name>Window:shadow(true)
    <name>Window:windowCallback(function(action)
        if action == "closing" then <name>Window = nil end
    end)
    <name>Window:url(APP .. "/<page>")
    <name>Window:show(0.12)
    <name>Window:bringToFront(false)
end

local function toggle<Name>Panel()
    -- pcall: an error inside an eventtap callback can take the tap down with it. A window handle
    -- that outlived its window is the realistic failure.
    local ok, err = pcall(function()
        if <name>Window then close<Name>Panel() else open<Name>Panel() end
    end)
    if not ok then
        print("<Key> toggle error: " .. tostring(err))
        <name>Window = nil     -- never leave a stale handle that eats every later press
    end
end
```

Binding it, two ways:

```lua
-- Simple: any normal chord.
hs.hotkey.bind({"cmd", "alt"}, "N", toggle<Name>Panel)
```

For a bare F-key you need an event tap, because macOS may deliver it as a media key:

```lua
-- Inside your existing hs.eventtap.new({hs.eventtap.event.types.keyDown,
--                                       hs.eventtap.event.types.keyUp, ...}) callback:
if keyCode == KEY then
    if isDown then
        if not <name>Held then <name>Held = true; toggle<Name>Panel() end
    else
        <name>Held = false
    end
    return true        -- swallow it so the app underneath never sees the key
end
```

Reload Hammerspoon after editing (`hs.reload()` or the menu). A reload **does not** prove the file
loaded cleanly — check the Hammerspoon console, or have the config write something observable
(timestamped file, alert) and look at that.

## 3. Gotchas worth keeping

| Symptom | Cause |
|---|---|
| Cancel does nothing, no error | Read `msg.action` instead of `msg.body.action` |
| Constructor throws "usercontent expected, got nil" | Controller must be the 3rd arg, after a prefs table |
| Can't type in the fields | Missing `allowTextEntry(true)` |
| A macOS title bar above your card | You called `windowStyle`; the default is already borderless |
| Save/Cancel hidden behind the Dock | Position from `frame()`, not the full screen rect |
| Panel flickers while the key is held | No `<name>Held` guard on auto-repeat |
| Key dead after one error | No `pcall`, or the stale handle wasn't cleared |

## 4. For Finance specifically

1. Add `public/add-entry.html` to the Finance project — one card, its own stylesheet, posting to
   whatever its "add" endpoint is; call `closeWindow()` on save/cancel/Escape.
2. Copy the Lua above with `<name>` = `finance`, `<Handler>` = `financePrompt`, `<Port>` = its port.
3. Open the page in a browser at the panel's width, measure the card's height, and put that in
   `w, h`.
4. Bind it to a free key. F3 is taken by the dashboard; a ⌘⌥ chord avoids the event-tap dance.

Both panels can coexist — separate windows, separate handler names, separate globals.
