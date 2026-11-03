# Game bridge

The bridge keeps Jun in JunOS and Jun in *My Dystopian Robot Girlfriend* in step: what you do in the game lands in her memory, her affection follows the game's sympathy and back, the wardrobe picks up what she wears in the game, and the in-game chat talks to JunOS. It is off unless you say yes in the installer (`GAME_BRIDGE`, see [configuration.md](configuration.md)).

There are two halves:

- **The boot sync**, `webapp/api/bridge-sync.php`. `start.sh` runs it in the php container and `start.ps1` runs it before the memory worker, once per start. It reads the newest save in `GAME_SAVE_DIR` and catches everything you played without the mod.
- **The mod**, `bridge/` (JunBridge, MelonLoader, C#). While the game runs it posts `JsonUtility.ToJson(GameVariables)` to `api/bridge.php` after every load and then once a minute when something changed, and sets the sympathy JunOS answers with on the live game. The game saves it itself. It also carries the in-game chat (the **Talk (AI)** button) and her voice through `api/chat.php` and `api/tts.php`. Each save keeps the id of its own JunOS conversation (`[Jun] ConversationId` in the cfg overrides it), the history comes from `api/conversations.php` every time the chat opens and nothing of it is stored in the save. `/reset` in the chat box drops the id, the next chat makes a new conversation and the old one stays in JunOS.

Both send the same JSON (the mod's body is the string a save keeps in `savedata`), so one parser (`webapp/api/lib/bridge/parse.php`) reads both and they produce the same event ids.

## Platforms

| | boot sync | mod |
| --- | --- | --- |
| Windows bare-metal | yes | yes |
| Linux, native build | yes | yes, started through `junos-game.sh` (below) |
| Linux, Proton (Windows build) | yes | yes, with `WINEDLLOVERRIDES="version=n,b" %command%` in the game's launch options |
| Colab / Kaggle | no game save there, skipped | a PC mod can point at a full Colab stack |
| Android app | no | no |

## Native Linux

MelonLoader 0.7.3 (`MelonLoader.Linux.x64.zip`) loads into the native build through `LD_PRELOAD`. The installer drops a `junos-game.sh` into the game folder that does it. In Steam the launch options are `"<game folder>/junos-game.sh" # %command%`. The first start downloads a portable .NET 6 and Cpp2IL and generates the game's assemblies, so it takes a minute. The installers do that start for you: they open the game once, wait for `N Mod loaded` in `MelonLoader/Latest.log` (10 minutes at most) and close it. On Linux that needs a screen (`DISPLAY` or `WAYLAND_DISPLAY`) and the native build, a Proton copy sets itself up on its first start from Steam.

Stock MelonLoader then segfaults on this game. To hook `MetadataCache::GetTypeInfoFromTypeDefinitionIndex(int)`, Il2CppInterop follows the jumps out of `il2cpp_image_get_class` for as long as each function has exactly one. In the Linux `GameAssembly.so`, the function before it (`GetTypeInfoFromHandle`, which takes a pointer) ends in two jumps to the same address, so the search stops one function early. The hook then hands a truncated pointer to code that expects an index, and the game crashes on start. `bridge/LinuxFix` is a small MelonLoader plugin (`Plugins/JunBridge.LinuxFix.dll`) with a Harmony postfix on that search: when every jump goes to the same address, it follows it. It does nothing outside Linux and warns if a newer Il2CppInterop renamed the hook.

Install stock MelonLoader 0.7.3, then put LinuxFix **0.2 or newer** in `Plugins/JunBridge.LinuxFix.dll`. That is the only extra file needed for these native Linux startup fixes; `Mods/JunBridge.dll` provides the separate JunOS bridge. LinuxFix embeds its native hook library and licenses, writes them automatically under `UserData/JunBridge.LinuxFix/`, and loads the library from there. No replacement bootstrap or extra preload is needed beyond MelonLoader's normal `LD_PRELOAD` launch. The installer checks the DLL against the release's `SHA256SUMS` and stages all downloads before changing game files. Close the game before updating the plugin; the native installer refuses a running copy and preserves an existing loader. Windows and Proton don't use this Linux plugin.

The plugin logs each resolved hook target in `MelonLoader/Latest.log`, including its offset in `GameAssembly.so`. The metadata hook is logged after the jump correction. This helps compare failed and successful launches without relying on absolute addresses, which change between runs.

The remaining intermittent native Linux startup crash was traced to MelonLoader 0.7.3's bundled Dobby allocator. Its `MAP_FIXED` allocation replaced a page already holding CoreCLR method metadata. In a captured failure, Dobby mapped `0x7f0f06304000` through `0x7f0f06304fff`; CoreCLR later tried to use the erased method descriptor at `0x7f0f06304b10`. Matching Microsoft symbols exposed the original CoreCLR fault behind a second fault in Unity's crash handler. The failed and successful launches logged the same four hook offsets, so varying hook targets weren't the explanation for that failure.

The embedded library uses Dobby's safe allocation and x64 far-trampoline implementation from `Ketlark/Dobby` commit `642dd93513d890acb7ceb0312b2c1a0a27668cce`, with the Linux compatibility changes in `bridge/LinuxFix/native/dobby-linux-memory.patch`. An occupied address is never remapped. If no nearby page is free, the trampoline can live farther away; relative branches and RIP-relative memory operands are rewritten to preserve their destinations. Linux also skips the fallback that treats zero bytes inside someone else's executable mapping as spare memory, and a failed relocation is rejected before patching the original function.

At `OnEarlyInitializeMelon`, LinuxFix replaces MelonLoader's managed bootstrap attach/detach delegates with callbacks into the embedded library. Later Il2CppInterop and mod hooks therefore use the corrected allocator. Hooks are tracked so their removal goes through the same library; removal of older hooks is forwarded to the original bootstrap. The bootstrap file stays unchanged. Plugin priority is the earliest supported value.

MelonLoader attempts an internal-call hook before loading plugins. LinuxFix cannot protect that earlier work or hooks installed by earlier user libraries. In the tested stock 0.7.3 environment, the internal-call hook fails its existing ClrMD check before native attachment; LinuxFix logs `loader hook present before plugin: False`. This is a tested drop-in fix for this game/loader combination, not a promise to fix crashes before plugins run or to support future MelonLoader internals.

GC or tiering settings don't repair an overwritten page. Before this fix, user batches of 16 launches had 3 crashes by default, 4 with `DOTNET_gcConcurrent=0`, and 2 with `DOTNET_TieredCompilation=0`; removing LinuxFix crashed 8/8 times. A standalone guard rejecting Dobby's occupied-address allocation also crashed at hook setup because the old allocator couldn't handle the failure. LinuxFix 0.1 only fixed the metadata target; update the DLL to get both fixes.

Rebuild with `bridge/LinuxFix/build.sh [MelonLoader directory] [Release|Debug] [output directory]` on Linux x86_64 with .NET SDK 8, a C++ compiler, CMake, git, curl, unzip and Python 3. Without a loader path it downloads the checksum-pinned stock 0.7.3 archive for references. It fetches the pinned Dobby source, applies the checked-in patch, and embeds the shared library and notices into `JunBridge.LinuxFix.dll`. No game files are needed. Native tests reserve 5 GB around a function to force a trampoline farther than 2 GB away, verify loads, address calculations and both conditional-branch outcomes, and check unhooking and neighboring occupied pages. Managed smoke tests exercise the real MelonLoader delegates, original-function calls, garbage collection, detach routing, first extraction and damaged-cache recovery.

The final single-DLL package completed eight isolated headless launches with JunBridge and Moan Mod and two with no mods, using stock MelonLoader 0.7.3. All ten reached the menu and stayed alive for 30 seconds. All 164 files in the official loader archive matched the test installation, and the real game's restored loader matches them too. Preserve a failed launch's `MelonLoader/Latest.log` before restarting, since the loader replaces it. Startup tests don't cover interactive chat, voice, graphics drivers or long gameplay sessions.

Checked headless on the 0.97.12 Linux build: the game reaches the menu and loads a save, JunBridge's patches apply, the first post carries the whole `GameVariables` (156 flags), the sympathy that comes back is on the live game by the next post, and `bridge_snapshot()` reads the posted JSON the same as a save file. The in-game chat wasn't tried there, it needs a running JunOS.

## The save

Checked against the free 0.97.12 Linux build from itch, run headless, with a 0.90.13 save loaded into it and saved again. The game keeps everything in `persistentDataPath/Saves/`: `~/.config/unity3d/IncontinentCell/My Dystopian Robot Girlfriend/Saves/` on Linux, `%USERPROFILE%\AppData\LocalLow\IncontinentCell\My Dystopian Robot Girlfriend\Saves\` on Windows.

- `save.mdrg` is the container (`SaveContainer` in the game): `{visitedWebsites, achievements, flags, storyTextIds_Comp, saves[], autoSaves[], nextAutoSaveIndex}`. Each entry is `{notes, description, _time, ingameTime, slot, savedata, _saveType}`, `_time` is FILETIME ticks and picks the newest one. On disk `savedata` is `""`.
- Each slot's `GameVariables` is its own file next to it: `M<slot+1>.mdrgslot` for manual saves (`_saveType` 0), `A<slot+1>.mdrgslot` for the 11 rotating autosaves (`_saveType` 1). The file is the raw `GameVariables` JSON.
- An export (Load > To file) is the same container with every `savedata` inline, as a JSON **string**. The bridge reads those too (`bridge-sync.php --file`).
- `Saves/Backup/` is the game's own and is skipped. Anything that isn't one of these shapes is refused for reading and never written.

| Game field | JunOS | Direction | How |
| --- | --- | --- | --- |
| `_sympathy` (0 and up, past 1000 is normal) | `relationship.affection` (0-100) | both | `round(min(sympathy, 1000) / 10)`, so anything over 1000 is 100. Back: `affection * 10`, but the game's own value is kept whenever it already maps to her affection, so 2400 stays 2400 while she's at 100 |
| `flags[]` `{name, firstTimeAdded}` | memory notes (`events`, source `game`) + journal | game to JunOS | `BRIDGE_FLAG_TEXT` in `lib/bridge/events.php`. Unmapped flags are skipped, `bridge-sync.php --dry-run` lists them |
| `timesCameInside`, `streamCount`, `timesWonChess`, ... | journal | game to JunOS | the increase since the last sync, one line per group (`BRIDGE_COUNTER_GROUPS`) |
| `botName` | memory note | game to JunOS | once per run |
| `itemManager.items[]` with an `_equipedSlot` | `wardrobe_state` | game to JunOS | `bridge_outfit_keys()` in `lib/bridge/parse.php`, by the ranges of the game's `ItemEnum`: 10xxx shirts, 11xxx panties (bikini ones to `bikini_bot`), 12xxx socks and stockings, 13xxx accessories (chokers, bow, wizard hat, headband, pointy ears), 14xxx bras, 15000/15002 skirts, 15001 pants, 16xxx shoes (left, right, pair), 17xxx hoodies, 18000 vintage dress to `dress`, 18001 slip dress to `dress1`, plus tails and ears. A mod item (non-empty `_gameId._guid`) reuses low ids, so it goes by its slot instead (`BRIDGE_OUTFIT_SLOTS`). `_equipedSlot` `""` is in the bag, `Anon_*` is the player's. 200-203 are the extra hair pieces (`hair_h1` to `hair_h4`). Makeup, piercings, nails and the heart choker map by id (`BRIDGE_OUTFIT_IDS`) |
| worn items' id, `_colors` and `FrontClippedUp` | `wardrobe_state.variants`, the colours in prefs | game to JunOS | `lib/bridge/look.php`: skirt, sock and shoe style, glasses and eyepatch, choker and hair accessory style, limbs, high-tech skin, hair clip, the logo of the shirt, hoodie and panties (`BRIDGE_LOGOS`) and every colour. `_colors` entries have no names in the game, the order in `BRIDGE_ITEM_COLORS` and `BRIDGE_SLOT_COLORS` comes from real saves. Mod items give colours but no styles. Her halo stays white unless a `DefaultHologram` is worn. Bare lips, mouth, blush and sleeve logos aren't mapped |
| `_stamina`, `_satiation`, stocks, `visitedWebsites` | nothing | | things she wouldn't know |

Item ids are stable: saves from 0.90.13, 0.96.7 and 0.97.4 agree with the 0.97.5 `ItemEnum`. Slot names can move (`EyeShadow` became `EyeMakeup` after 0.90.13), and `BRIDGE_OUTFIT_SLOTS` and `look.php` read them, so check those on a game update.

## Sync rules

JunOS has the last say. "Both changed" means you played the game and chatted on the web between two syncs.

- **First sync:** the game seeds her affection, the wardrobe and her memory.
- **Same run** (same `botName|playerName`, in-game `time` not earlier than last time): the change in mapped affection since the last sync goes through `relationship_apply()` as a delta (1300 to 1250 moves nothing, both are 100), so play on both sides counts, then the game gets her value back. Loading an older save or another run moves nothing.
- **Events** only get added. Ids are `flag:<name>:<firstTimeAdded>` and `count:<group>:<run>:<total>`, kept hashed in `bridge_seen`, so re-reading a save or switching slots never repeats one.
- **Outfit:** the game's outfit is taken when it or its styles and colours changed since the last sync and the wardrobe didn't. Otherwise the wardrobe stays. The pieces apply straight away, the styles and colours wait in `bridge_sync.look_pending` until a signed-in page loads: `outfit.php` hands them over once, and the browser resolves the logos against its catalog and saves them like any wardrobe change. Prefs are encrypted and the mod has no data key, so the server can't write them itself. A page that's already open shows all of it after a reload. The mod doesn't put JunOS's outfit on her in the game yet.

## Memory without a session

Memory files are encrypted under the data key, which only exists while you're signed in. The boot sync has no key, so it seals each batch with `crypto_box_seal` to a per-user public key (`users.bridge_pub`, made on your next sign-in, the secret half sealed under the data key in `users.bridge_sec`) and puts it in `bridge_inbox`. The next sign-in or chat turn opens the inbox and writes notes and journal lines. What the boot sync has to read without a key stays readable in `bridge_sync`: the last sympathy, in-game time, counters and her game outfit with its styles and colours, the same numbers the save keeps unencrypted on the same disk. The run name and the event ids are SHA-256 hashes. Before that key exists, events stay unseen and the next sync tries again.

## Writing the save

`GAME_SAVE_WRITE=on` only, and never while the game runs (`start.sh` checks `pgrep`, `start.ps1` checks `Get-Process`). `lib/bridge/write.php`:

1. finds the one `"_sympathy":<n>` in the slot file (in an export, the chosen entry's escaped `\"_sympathy\":<n>`) and replaces only those digits, no re-encoding (PHP would turn `75.0` into `75` and `{}` into `[]`)
2. requires the patched file to decode to the old one with that one field changed, every other field identical
3. copies the original to `<state>/bridge-backups/` (the last 10 kept)
4. writes a temp file next to the save, checks it again, and renames it over the save only if the save's mtime hasn't moved meanwhile

Any failure leaves the save untouched and says why on the start output. Tested on the real game: a slot patched from 813 to 500 changed 3 bytes, the game loaded it, and the next save it wrote itself carried `"_sympathy":500`. `save.mdrg` is never written.

## Pairing

The sign-in opens once the game's main menu is up (a `MainMenuScene.Prepare` postfix, or `ViewScene.Prepare` on builds like 0.97.5 that don't override it), never over the splash screens, and **F8** opens it any time after. It uses the game's own input popups: enter your webapp email, choose **Next**, then enter your masked password and choose **Sign in**. A failed sign-in reopens the password popup with the reason. If the game drops your keyboard's `@` combination (including Italian AltGr + ò), **Insert @** adds it at the cursor in the email field. Keyboard paste still works. **Not now** or closing the popup cancels sign-in. The game's IMGUI text fields are stripped from the build, so the mod can't draw its own window: `GUI.SetNextControlName` never returns and `GUI.TextField` throws `Method unstripping failed`. There is no separate Bridge account.

The mod pairs itself. When it has no session, or JunOS answers 401 or 403 (sessions last 30 days; a password change ends every other session), it shows the sign-in popup in the game. It logs in through `api/auth.php` like the browser, keeps the two session cookies (`omega_session`, `omega_key`) in `JunBridge/session` under the user's local app data (`%LOCALAPPDATA%` on Windows, `~/.local/share` on Linux, mode 600), and never stores the password. With a session and no token it posts to `api/bridge-pair.php` and writes the token it gets into `[Sync] Token`.

Chat, conversation history, voice and pairing requests reopen the popup on 401 or 403 and retry once after a successful sign-in. A second refusal is reported without another popup. A 401 from `api/bridge.php` (Unpair, a new token from Settings, factory reset) drops the token and pairs again, asking to sign in first if it has to. A 403 from that endpoint drops the token and asks for sign-in before pairing again.

An unreachable JunOS does not open an automatic popup, the mod tries again on the next chat or sync. **Not now** closes the box until the next thing that needs a session. A password left in the cfg by an older `start.ps1 bridge` is used once and blanked.

Every start, `start.ps1` / `start.sh` writes `ApiUrl` into the mod's `UserData/JunBridge.cfg` (`https://127.0.0.1:<JUN_PORT>` on Windows, `https://localhost` on Docker, `https://<DOMAIN>` with a real certificate) and copies the local CA to `UserData/JunBridge.ca.pem`. The mod accepts a certificate the system trusts, or one that chains to that CA, so `trust` isn't needed for the game. Every request carries an `Origin` header built from `ApiUrl`, which `require_same_origin()` wants on a cookie POST. `.\start.ps1 bridge` / `./start.sh bridge` does the same refresh without a full start.

Settings > Account > **Game bridge** shows when it last synced. **Pair** still issues a token by hand (shown once, stored hashed) for a mod on another PC, pasted as `Token` under `[Sync]`. **Unpair** revokes it. Factory reset wipes the bridge tables too.

## Building the mod

`bridge/build.ps1 -GamePath <game folder>` builds `JunBridge.dll`; `bridge/build.sh <game folder>` on Linux also builds LinuxFix, including its embedded native helper. JunBridge needs the `MelonLoader/Il2CppAssemblies` generated from your own game, so CI cannot build that mod. The LinuxFix plugin needs only public MelonLoader references and a Linux x86_64 native toolchain; Windows users take its release DLL if they also maintain a native Linux install. For a release, upload `JunBridge-<tag>.dll` to the draft and rerun the release workflow so its checksum is included. `linux-fix.yml`, shared by CI and the release workflow, builds `JunBridge.LinuxFix-<tag>.dll` automatically and the draft includes its checksum. Both installers pin MelonLoader to the tested 0.7.3. They refuse a DLL without its checksum line and skip the mod if required release assets are missing.

The mod started as a copy of the Jun provider, chat, voice and patches from MdrgAiDialog (Apache-2.0, see NOTICE), with every other provider, the provider layer and the `#!flow` commands removed. JunOS's `[A:...]` tags only ever turn into expressions and blush.

## Memory: ideas for later

The bridge doubles the stream of small events going into her memory, and the current notes + journal split doesn't scale well with that. Some directions:

1. **Episodes + digest.** Every source (chat, date, game) writes small dated episodes. The idle pass rolls each day into one journal paragraph and only promotes facts that repeat or matter into notes. The prompt gets the notes plus the last few days.
2. **Tiered recall.** A pinned core (names, boundaries, the relationship) always goes in the prompt. Recent episodes go in by recency. The rest is only reachable through a `search_memory` tool, keyword-matched like `search_recent_chats`, with a salience score that decays unless something recalls it.
3. **One timeline.** A single encrypted, append-only log, with categories and the journal as views over it. One place to dedup, and one id space across chats, outings and game events (the bridge's ids already fit).
