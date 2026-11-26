# Repository maintenance

## Environment

- Use Node.js 24.11 or later with npm. GitHub Actions uses Node.js 24, Ubuntu, and the Playwright Chromium revision selected by each package lockfile.
- Use Violentmonkey for installed-script checks. On the user's computer, use only the Codex in-app browser (`iab`), keep test tabs hidden, and mute media before playback. Run Playwright browser tests in an authorized separate environment such as GitHub Actions.

## Build and local tests

Run these commands from the affected script directory. Each directory owns its npm lockfile and uses strict TypeScript, esbuild, and Terser.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run check:build
```

After changing a script source, run `npm run build` to regenerate its distribution, then rerun `npm run check:build`.

Cover each changed behavior and regression with automated unit and feature tests. Run both kinds during local development and in CI. Run tests that do not launch a browser from the affected package directory. For browser-facing behavior, run automated feature tests in `iab` during development with the exact built `.user.js` installed through Violentmonkey. Verify successful injection and assert the feature's observable outcomes. Use automated tests for all development and release verification. Interactive use is production use.

In the browser-test environment, run `npx playwright install chromium` and `npm run check` from each script directory. Use `npx playwright install --with-deps chromium` on Linux runners that need system libraries. Run YouTube's `npm run test:stock` and `npm run test:live` there as well. Set `SPONSORBLOCK_EXTENSION` to the directory containing the verified extension manifest. The YouTube workflow specifies the official archive and its checksum. Run `npm run test:music` separately when the runner has guest access to YouTube Music search.

## CI

- `.github/workflows/ozon-search.yml` checks syntax, lint, types, reproducibility, product filtering, cart and listing lifecycle, and sensitivity to rating and delivery regressions.
- `.github/workflows/skip-twitch-muted-segments.yml` checks syntax, lint, types, reproducibility, seekbar and playback behavior, and sensitivity to paused playback and channel recording regressions.
- `.github/workflows/youtube-tools.yml` checks types, lint, reproducibility, desktop and mobile behavior, and the YouTube Music playback guard. Its integration job checks live desktop and mobile YouTube, including SponsorBlock. Report stock guest-playback challenges and confirmed Google unusual-traffic redirects as skipped coverage. A blocked stock playlist also skips dependent playback tests for that host.

Each workflow runs on pushes and pull requests and supports `workflow_dispatch`. Run its commands from the script directory and use that directory's lockfile for caching. Verify every workflow for the published commit SHA.

## Maintenance

- Treat each `*.src.ts` and its imported modules as the source of truth. Regenerate the corresponding `*.user.js` with `npm run build`. Keep the single classic script, matching metadata, and reproducible bytes. Commit the generated file for direct installation.
- Use a single positive integer for `@version` (`1`, `2`, `3`, …). Start each new script at `1` and increment its version by one whenever its distributed code or metadata changes.
- Keep each script's README installation link, `@updateURL`, and `@downloadURL` on the same raw file in `master` so published Git tags can advance independently of update URLs. Keep `@name` and `@namespace` stable because they determine the installed identity.
- Use the root GPL-3.0 `LICENSE` for project code and preserve mandatory third-party notices. Keep the root `README.md` and `AGENTS.md` as the repository's Markdown files. Update this guide when project rules, behavior, or verification procedures change.
- Ozon uses Navigation API events to reset filters on URL changes. Cover back and forward navigation and SPA transitions that render a listing in browsers without the API.
- Twitch uses the committed recording identifier exposed by the player and seekbar in the page context when available. Cover transitions where the media and its new seekbar become available at different times. Apply muted ranges only once both refer to the new recording.

## Required automated feature coverage

Assert these behaviors in the feature suites. Use deterministic fixtures for errors, timing, and network races. Exercise affected live-page flows in `iab` during development.

- **Installation and updates.** Assert that the README installation link produces a single enabled Violentmonkey entry with the distributed version, both update URLs resolve to the same distribution bytes, and the exact artifact injects successfully after a target page reload.
- **Ozon.** Assert that rating and review-count ranges below the native price filter apply to existing and newly loaded cards. On Ozon Fresh, assert that **За 30 минут** retains only marked cards within both ranges. Cover resets after search or category changes and preserve native cart delivery controls.
- **Twitch.** Cover `/videos/ID` and `/CHANNEL/video/ID`. Assert that seeking into a muted range preserves position while paused, resuming skips that range and adjacent muted segments, and seeking outside muted ranges preserves the requested position.
- **YouTube.** On desktop and mobile, assert that thumbnail feedback shows YouTube's confirmation with **Undo**. Cover **Watched videos** for fully and partially watched videos on Home and channel pages. With sound muted, assert that **Audio only** advances playback without rendered frames after reload and navigation, and that disabling it restores frames. Cover playlist end and navigation by **Next**, **Previous**, and a playlist item.
- **YouTube Music playback.** Assert that search retains songs and filters official videos. Cover mixed playlists opened from Home and a playlist page, initial playback after queue population, **Next**, automatic advancement, and repeat across a video at the tail. Assert that direct official video links stay stopped. Cover a single native continuation for a recommendations queue ending in clips, selection of the next song after loading, and retention of the current song when continuation exhausts or fails. Cover leaving and returning to a named playlist during a pending continuation and preserving the selected song when playable entries arrive.
- **YouTube Music library.** Assert that the bookmark appears between rating and the action menu on desktop and beside the title in the mobile full player. Cover save and remove through the shortcut and the native menu. Restore the original library state when exercising a live test track.
- **YouTube Music lyrics.** On desktop and mobile, assert the eight-second loading deadline, the switch to synced or plain lyrics, safe track and tab changes during loading, and persistence through native lyrics refresh. Assert that timed lyrics requests to `music.youtube.com` omit credentials. Assert that plain text stays white at the synced font size, scrolls smoothly without a scrollbar, accepts scroll input, and resumes following four seconds after that input. Assert that the control immediately before desktop volume toggles filling without interrupting synced lyrics, that active lines transition without a flash, and that hovering an inactive seekable line animates to an intermediate brightness.
- **YouTube Music lyrics navigation.** Assert that synced lyrics follow forward and backward seeks with the active line above center and with spacing at both ends. Cover source attribution and the two-second follow delay after scroll input. Verify mouse, touch, and keyboard seeking preserves playback state. Cover the fallback to **Up next** for tracks without lyrics, restoration of **Lyrics** when available, and retention of **Up next** when the user explicitly chooses it during fallback.

## Release

1. Verify that all three workflows passed for the published `master` commit and that automated installation and update tests passed for the release files.
2. Use `v1` for the first GitHub release and Git tag. For every subsequent release, including fixes and prereleases, increment `N` by one. Use the same `vN` for the release title and tag. Each userscript has its own `@version` sequence.
3. Create the tag at the verified commit. Describe changes since the previous release. If attaching installable assets, use the verified userscript bytes and include `vN` in their filenames. Verify the tag, publication status, and asset links in GitHub.
