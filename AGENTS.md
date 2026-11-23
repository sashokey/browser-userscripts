# Repository maintenance

## Environment

- Use Node.js 24.11 or later with npm. GitHub Actions uses Node.js 24, Ubuntu, and the Playwright Chromium revision selected by each package lockfile.
- Use Violentmonkey for installed-script checks. On the user's computer, use only the Codex in-app browser (`iab`), keep test tabs hidden, and mute media before playback. Run Playwright browser tests in an authorized separate environment such as GitHub Actions.

## Build and local checks

Run these commands from the affected script directory. Each directory owns its npm lockfile and uses strict TypeScript, esbuild, and Terser.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run check:build
```

After changing a script source, run `npm run build` to regenerate its distribution, then rerun `npm run check:build`.

In the browser-test environment, run `npx playwright install chromium` and `npm run check` from each script directory. Use `npx playwright install --with-deps chromium` on Linux runners that need system libraries. Run YouTube's `npm run test:stock` and `npm run test:live` there as well. Set `SPONSORBLOCK_EXTENSION` to the directory containing the verified extension manifest. The YouTube workflow specifies the official archive and its checksum. Run `npm run test:music` separately when the runner has guest access to YouTube Music search.

## CI

- `.github/workflows/ozon-search.yml` checks syntax, lint, types, reproducibility, product filtering, cart and listing lifecycle, and sensitivity to rating and delivery regressions.
- `.github/workflows/skip-twitch-muted-segments.yml` checks syntax, lint, types, reproducibility, seekbar and playback behavior, and sensitivity to paused playback and channel recording regressions.
- `.github/workflows/youtube-tools.yml` checks types, lint, reproducibility, desktop and mobile behavior, and the YouTube Music playback guard. Its integration job checks live desktop and mobile YouTube, including SponsorBlock. Report a stock guest-playback challenge recorded by the job as skipped coverage. Use the manual checks below for live YouTube Music.

Each workflow runs on pushes and pull requests and supports manual dispatch. Run its commands from the script directory and use that directory's lockfile for caching. Verify every workflow for the published commit SHA.

## Maintenance

- Treat each `*.src.ts` and its imported modules as the source of truth. Regenerate the corresponding `*.user.js` with `npm run build`. Keep the single classic script, matching metadata, and reproducible bytes. Commit the generated file for direct installation.
- Increase the numeric `@version` of a changed userscript, including metadata changes. Keep its README installation link, `@updateURL`, and `@downloadURL` on the same raw file in `master` so published Git tags can advance independently of update URLs. Keep `@name` and `@namespace` stable because they determine the installed identity.
- Use the root GPL-3.0 `LICENSE` for project code and preserve mandatory third-party notices. Keep the root `README.md` and `AGENTS.md` as the repository's Markdown files. Update this guide when project rules, behavior, or verification procedures change.
- Ozon uses Navigation API events to reset filters on URL changes. On browsers without the API, verify back and forward navigation and SPA transitions that render a listing.
- Twitch uses the committed recording identifier exposed by the player and seekbar in the page context when available. During a transition, verify the new media and its seekbar together before applying any muted range.

## Manual checks

1. In a Violentmonkey profile without the script, open its README installation link and confirm installation. Expect one enabled entry with the distributed version. Verify that both update URLs resolve to the same script bytes, then reload the target page and confirm successful injection.
2. **Ozon** — Open a desktop listing, set rating and review-count bounds below the native price filter, then scroll. Expect both ranges to apply to existing and newly loaded cards. On Ozon Fresh, enable **За 30 минут** and expect only marked cards within the ranges. Change the search or category and expect the ranges to reset. In the cart, Ozon controls delivery choices.
3. **Twitch** — Open a recording with a visible muted seekbar range. Seek into it while paused and expect playback to stay at that position. Resume muted playback and expect it to jump past the range, including adjacent muted segments. Seek into an unmuted range and expect it to stay at the selected position. Exercise both `/videos/ID` and `/CHANNEL/video/ID`.
4. **YouTube** — Check desktop and mobile. Use a thumbnail feedback control and expect YouTube's confirmation with **Undo**. Toggle **Watched videos** in the desktop account menu or mobile **Settings** and confirm that fully and partially watched videos can be shown or hidden on Home and channel pages. Enable **Audio only**, keep the player muted, then reload or open another video. Expect playback time to advance without rendered video frames. Disable the setting and load a video to confirm that frames return. In a playlist, expect playback to stop at the end and resume navigation through **Next**, **Previous**, or a playlist item.
5. **YouTube Music** — Open Home and search for a song with an official video. Expect song results to remain visible and the video to be hidden. Start a playlist that contains both songs and videos and keep the player muted. Expect **Next** and automatic advancement to play songs. In an infinite recommendations queue whose loaded tail contains only clips, check that the native continuation starts once and selects the next song after loading. When the continuation is exhausted or fails, expect the current song selection to remain. Enable repeat for the whole queue and expect playback to wrap to the first song when the final item is a video. Open a direct link to an official video and confirm that playback stays stopped. While signed in, check that the library bookmark appears between the rating buttons and action menu on desktop and beside the title in the mobile full player. Use a test track to verify saving and removing it through both the shortcut and the action menu. Restore its original library state.

## Release

1. Verify the published `master` commit in all three workflows and complete the installation and update checks for the release files.
2. Use `v1` for the first GitHub release and Git tag. For every subsequent release, including fixes and prereleases, increment `N` by one. Use the same `vN` for the release title and tag. Keep the userscripts' numeric `@version` values for Violentmonkey.
3. Create the tag at the verified commit. Describe changes since the previous release. If attaching installable assets, use the verified userscript bytes and include `vN` in their filenames. Verify the tag, publication status, and asset links in GitHub.
