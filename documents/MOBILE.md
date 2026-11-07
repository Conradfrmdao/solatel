# Mobile play and installation

## Current behavior

The existing Input command path is shared by touch, keyboard and gamepad.
The joystick anchors movement at touchdown, with a circular dead zone: touching
below its visual centre cannot send an accidental backward command. Drag upward
to move forward. Tap Sprint to run forward in the direction the camera faces;
tap again to stop. Moving the stick overrides automatic forward movement.
Backing up, aiming, firing, grenades and crouching stop sprint. The authoritative
server's existing movement speeds and sprint restrictions are unchanged.
ADS is a toggle. Fire supports dragging to look while held. Short jump/reload
taps survive until the next input sample. Blur and rotation clear held touch
actions. The existing layout editor still saves per-device positions and sizes.

Phone controls use safe areas and the visual viewport. The renderer and camera
resize from the canvas bounds when the browser toolbars or orientation change.
Health is small at top left; weapon/ammo is at bottom centre. Normal mobile play
hides diagnostics. Add `?debug=1` to show them for troubleshooting.
The low mobile preset renders at one CSS pixel per canvas pixel, rather than
the old 0.75 scale. This improves sharpness but increases GPU pixel work; real
device frame rate and thermals must be checked before raising this further.

## Installation

The build emits `manifest.webmanifest`, plus `manifest.json` for compatibility.
It requests standalone display and landscape, provides 192/512 pixel icons and
a padded maskable icon. Apple web-app metadata and the touch icon are included.
The live site uses HTTPS. There is no service worker: installation does not
require one, and no wallet, payment, account, multiplayer or other response is
intercepted or cached. A live connection is required to play.

The mobile recommendation appears in the lobby once per tab session. It is
optional, can be dismissed, and can be reopened from Settings. Installed app
contexts suppress it. An active match suppresses it.

Android browsers that fire `beforeinstallprompt` get their native prompt from
the Add to Home Screen button. Accepting is not treated as proof of installation;
only `appinstalled` or a detected standalone/fullscreen context confirms it.
Without that event, the app shows manual browser-menu instructions.

On iPhone, the guide explains Safari Share, Add to Home Screen, Open as Web App
where available, Add, then launching the new icon. Installation cannot be forced.
The app cannot hide Safari's bars from an ordinary iPhone browser tab. Home Screen
mode removes normal browser toolbars, but iOS can retain system UI and ignore
orientation locking. The gameplay portrait overlay can be dismissed and never
blocks the lobby. Fullscreen and landscape requests remain tied to a real gesture.

## Verification and real-device checklist

Node input tests cover sprint start/cancellation and existing combat controls.
Run `node --test client/*.test.mjs`. After `node client/build.mjs`, the touch and
installation browser checks run with `node client/mobile-smoke.mjs` (Chrome is
expected at its standard Windows location; screenshots go into `.artifacts`).
Browser emulation used actual touch events at 844x390, 568x320 and 852x300 CSS
pixels, checking neutral touchdown, forward drag, sprint toggle, ADS, short jump
taps, control bounds and compact weapon HUD. Browser tests exercised the manual
installation guide, session dismissal/reload, native prompt invocation, confirmed
installation and hiding the popup during gameplay. These are not physical iOS QA.

On a physical Android phone and iPhone:

1. Open the HTTPS site in portrait and landscape; dismiss/reopen the install card.
2. Android: install with the native prompt if offered. iPhone: follow the guide.
3. Launch from the icon; check that browser toolbars are absent. Rotate manually
   if needed. Do not expect iOS to guarantee locking or hide its status bar.
4. Join a match. Touch the lower half of the stick, then drag up: there must be
   no backward kick. Tap Sprint with no other finger down; run, then tap to stop.
5. Use movement, look and Fire together. Toggle ADS. Tap jump, crouch and reload.
6. Expand/collapse browser bars and rotate mid-match. Check notches and the home
   indicator, HUD alignment, camera aspect and absence of stuck movement.
7. Customize a button, resize it, reload and reset. Check the popup never appears
   during a match. Confirm desktop keyboard/mouse and gamepad still work.
8. Compare mobile sharpness and sustained FPS/temperature on low and medium.

## Sources

- [Activision: mobile controls](https://blog.activision.com/call-of-duty/2019-10/Getting-a-Grip-on-the-Call-of-Duty-Mobile-Controls)
- [MDN: installable PWAs](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [MDN: native install prompt](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event)
- [WebKit: Home Screen apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [WebKit: iPhone fullscreen limitation](https://bugs.webkit.org/show_bug.cgi?id=206854)

## Phone layout, audio and Yard follow-up

The control editor's **Sensitivity & button behavior** panel saves a separate
touch multiplier and Hold or Toggle for Aim, Crouch and Sprint. The default
swipe sensitivity is 115% of the previous speed. Hold Grenade with the right
thumb, drag to aim and release to throw. The left thumb can steer throughout.

The lobby, editor and gameplay controls apply the device safe insets plus an
inward margin. The canvas still fills the viewport. The matchmaking and results
cards have scrollable details and pinned action buttons. The phone splash uses
a fitted logo over the scenic artwork. Rotation no longer feeds a measured
width back into the root layout width.

Audio retries from a completed touch, after returning to the app, and after an
iOS AudioContext interruption. It requests a playback audio session on browsers
that support it and respects the in-game volume. Test sound on a physical iPhone
and Android device, including Home Screen mode, the Ring/Silent switch, and
leaving and returning to the app.

Yard uses brighter concrete and cargo paint with a higher indirect light floor
across graphics presets. First match preparation overlaps the floor scan and
wall texture loads. Its map prefetch is about 7.6 MB smaller in source asset
bytes. Ranger and Ghost models load when a selected or match skin uses them.
Actual time saved depends on which skins are present, the network, and the GPU.

After building, run `node client/mobile-screens-smoke.mjs` for the phone screen
checks and screenshots. These cover simulated cutouts, viewport rotation, the
loading/results actions and the expanded control editor. They use Chrome phone
emulation. Check physical Safari and Android for hardware audio, cutouts, frame
rate and match load time.
