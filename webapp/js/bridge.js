// TEMPORARY. the scripts that are still classic reach the modules
// through these globals until they're converted too.
import * as Auth from './core/auth.js?v=1';
import * as ChatAPI from './core/chat-api.js?v=1';
import { loadScripts } from './core/loader.js?v=1';
import * as Names from './core/names.js?v=1';
import * as Prefs from './core/prefs.js?v=1';
import * as ui from './core/ui.js?v=1';
import * as MobileViewport from './core/viewport.js?v=1';
import * as Outfit from './outfit/outfit.js?v=2';

Object.assign(window, { Auth, ChatAPI, loadScripts, Names, Prefs, ui, MobileViewport, Outfit });
