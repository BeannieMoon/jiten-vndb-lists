# Jiten Difficulty for VNDB Lists

A small userscript that shows [Jiten](https://jiten.moe) difficulty on [VNDB](https://vndb.org) **list** pages,
so you can see at a glance which visual novels are easy or hard to read in Japanese, and sort by it.

> ### ⭐ First, install Jiten Everywhere
> This script is only a companion. The real star is **[Jiten Everywhere](https://greasyfork.org/scripts/600904)**
> by nerenar ([GitHub](https://github.com/nerenar/jiten-everywhere)). It brings Jiten's difficulty and deck
> information to media pages across the web, including VNDB's own VN pages.
> If you study Japanese with visual novels, it is highly recommended. Install it first. Then add this script
> if you also want difficulty on whole lists.

## What it does

![A VNDB user list sorted by Jiten difficulty](screenshots/user-list.png)

- Adds a **Jiten** column to VNDB tables that have one row per VN:
  - your list (`/u…/ulist`), wishlist and votes;
  - the `/v` browse and search list;
  - staff and voice-actor pages (`/s…`).
- Shows difficulty as a **percentage** (Jiten's 0–5 scale), **colored** from green (beginner) to red (insane).
  Hover over it for the exact score, the difficulty name and the character count. Click it to open the deck on Jiten.
- **Sorts** the list by difficulty. Click the *Jiten* column header or the floating button in the bottom-left corner
  (the first click sorts hardest first, the next easiest first).
  Titles that aren't on Jiten always go last.
- **Sorts the whole list, not just one page.** If your list spans several pages, the first sort loads all of them
  (up to 60 pages) into one table. The `/v` browse list has over a thousand pages, so it is sorted one page at a time.
- Marks titles that aren't on Jiten with a dim **NA**. With a Jiten API key set, titles that are already
  **requested** show **req.** instead.
- On producer pages (`/p…`), VNDB lists each VN with its releases underneath, so the value goes next to the VN title
  and the page isn't reordered.

**Browse list** (`/v`), hardest first:

![Browse list sorted by Jiten difficulty](screenshots/browse-sorted.png)

| Staff / VA page | Producer page |
|---|---|
| ![Staff page](screenshots/staff-page.png) | ![Producer page](screenshots/producer-page.png) |

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open **[jiten-vndb-list-difficulty.user.js](https://raw.githubusercontent.com/BeannieMoon/jiten-vndb-lists/main/jiten-vndb-list-difficulty.user.js)**
   and confirm the install. Updates come from this repository automatically.
3. Reload any open VNDB tabs.

On Chrome and Edge, Tampermonkey may also need *Allow user scripts* (or *Developer mode*) switched on
in the browser's extension settings.

## Optional: Jiten API key

Everything works without a key. A key only adds the *already requested* check for titles that aren't on Jiten.

1. Copy your key from [jiten.moe/settings](https://jiten.moe/settings) → *Advanced* → *API Key*.
2. Open the Tampermonkey menu on a VNDB page and choose **Set Jiten API key**.

## How it works

The script downloads Jiten's list of visual-novel and game decks that link to VNDB (about 60 small requests).
It keeps that list for 24 hours, so later pages show their values instantly.
After a day it shows the saved list straight away and refreshes it quietly in the background.
To force a refresh, choose **Refresh Jiten data now** in the Tampermonkey menu.

It only talks to `api.jiten.moe` and, to load the other pages of a list, `vndb.org` itself.

## Credits

- Difficulty data: [Jiten](https://jiten.moe).
- Companion to [Jiten Everywhere](https://github.com/nerenar/jiten-everywhere) by nerenar.
- Not affiliated with Jiten or VNDB.

## License

[MIT](LICENSE)
