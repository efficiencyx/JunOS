#!/usr/bin/env python3
"""Recover webapp/assets from the game's Unity data files.

Rebuilds everything the webapp needs straight from the game install
(no intermediate dumps required):

  interaction_model.moc3        CubismMoc blob in resources.assets
  interaction_model.model3.json generated (moc + the three atlases)
  texture_00/01/02.png          base atlases, resolved through each
                                drawable's CubismRenderer main texture
  variants/*.png                clothing variants: alpha-composite of the
                                layer textures listed in each item's
                                PackedTexturesContainer, plus the four
                                standalone logo textures
  variants/game_items.json      every packed item layer and ColorIndex
  variants/hair/**              separately colorable native hair strands
  variants/limbs/**             per-drawable crops of the packed variant
                                textures (Experimental limbs + High-Tech
                                skin), with mapping.json for outfit.js

Usage:
  python3 tools/recover_assets.py [--game DIR] [--out DIR]

Requires: UnityPy, Pillow  (pip install UnityPy Pillow)
"""

import argparse
import glob
import hashlib
import json
import os
import platform
import re
import struct
import sys

from PIL import Image
import UnityPy

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# linux and windows builds ship identical unity data. the folder is named
# factorial-omega-<platform>-64 either way and holds this marker directory.
GAME_GLOB = "factorial-omega-*-64"
GAME_MARKER = "My Dystopian Robot Girlfriend_Data"
DEFAULT_OUT = os.path.join(REPO, "webapp", "assets")


def _search_roots():
    home = os.path.expanduser("~")
    roots = [os.getcwd(), REPO, home]
    roots += [os.path.join(home, d) for d in ("Documents", "Documenti", "Downloads", "Desktop", "games")]
    if platform.system() == "Windows":
        roots += ["%s:\\" % chr(c) for c in range(ord("C"), ord("H"))]
        roots += [p for p in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")) if p]
    else:
        roots += ["/opt", "/usr/local/games", "/games"]
    seen, out = set(), []
    for r in roots:
        r = os.path.abspath(r)
        if r not in seen and os.path.isdir(r):
            seen.add(r)
            out.append(r)
    return out


def find_game_dir():
    for root in _search_roots():
        for pat in (os.path.join(root, GAME_GLOB), os.path.join(root, "*", GAME_GLOB)):
            for cand in sorted(glob.glob(pat)):
                if os.path.isdir(os.path.join(cand, GAME_MARKER)):
                    return cand
    sys.exit("no game install found; pass --game DIR (searched for %r)" % GAME_GLOB)

VARIANTS = {
    "sneakerL": "leftSneaker_interaction",
    "sneakerR": "rightSneaker_interaction",
    "classyShoeL": "leftClassyShoe_interaction",
    "classyShoeR": "rightClassyShoe_interaction",
    "kneehighSockL": "kneehighSocksLeft_interaction",
    "kneehighSockR": "kneehighSocksRight_interaction",
    "longSockL": "leftLongSock_interaction",
    "longSockR": "rightLongSock_interaction",
    "lingerieSockL": "leftLingerieSock_interaction",
    "lingerieSockR": "rightLingerieSock_interaction",
    "shortSockL": "shortSockLeft_interaction",
    "shortSockR": "shortSockRight_interaction",
    "stripedStockingL": "strippedStockingLeft_interaction",
    "stripedStockingR": "strippedStockingRight_interaction",
    "twostripedStockingL": "twostripedStockingLeft_interaction",
    "twostripedStockingR": "twostripedStockingRight_interaction",
    "stirrupL": "sitrrup_left_interaction",
    "stirrupR": "stirrup_right_interaction",
    "miniskirt": "miniskirt_interaction",
}

# glasses share ModdableFace. their sections come out of layer
# order, so sort them before compositing.
GLASSES = {
    "glasses": "glasse_common",
    "heartGlasses": "heartGlasses_common",
}

LOGOS = {
    "logoGamerTshirt": "GamerTshirt",
    "logoPriestbot": "priestbot_tshirt",
    "logoShcHoodie": "shcHoodie",
    "logoShcPanties": "shcPanties",
}

# DECALS maps variants/logos/<key>.png to Texture2D names in
# SpriteTextureDataGenerated, the Sprites/Logos registry for
# OtherLogos and PartnerLogos. every entry can go on
# Moddable*Logo. keep this in sync with LOGO_CATALOG in
# webapp/js/outfit.js.
DECALS = {
    "aguiLogo": "AGUI_Logo",
    "avocado": "Avocado",
    "baka": "Baka",
    "banana": "Banana",
    "bedabots": "Bedabots_Logo",
    "bloodyMoon": "BloodyMoon",
    "botLogo": "BotLogo1",
    "bow": "Bow",
    "cazino": "Cazino",
    "celestyn": "CELESTYN",
    "cherry": "Cherry",
    "cia": "CIA",
    "cosplayHouse": "CosplayHouse",
    "ddLogo": "DDlogo1",
    "diabete": "Diabete",
    "diabeteColaPow": "DiabeteColaPow",
    "diabeteDrSugar": "DiabeteDrSugarTrans",
    "diabeteSweetPotato": "DiabeteSweetPotatoTrans",
    "diabeteTransparent": "DiabeteTransparent",
    "dogeCoin": "DogeCoin",
    "fishFearMe": "fishFearMeLogo",
    "flowerkidv": "Flowerkidv",
    "fruitPlus": "Fruit+",
    "fungus": "FungusLogo",
    "galaxy": "galaxy",
    "gamerTshirt": "GamerTshirt",
    "hikkeiru": "HikkeiruLogo",
    "hotPinkGames": "HotPinkGames_Logo",
    "inHeat": "InHeatLogo",
    "lightSonic": "LightSonic",
    "luxe": "Luxe",
    "madJoram": "MadLogo",
    "milfHunter": "MILF",
    "mirthal": "mirthal",
    "monizmed": "Monizmed",
    "mushroom": "Mushroom",
    "nitrori": "NitroriLogo",
    "nuteku": "NutekuLogo",
    "peach": "Peach",
    "polandball": "Polandball",
    "priestbot": "priestbot_tshirt",
    "projektMelody": "projekt_melody_nbtw_logo",
    "projektMelody69": "projekt_melody_nbtw_69",
    "radioactive": "radioactive",
    "rehabTech": "RehabTech",
    "rose": "Rose",
    "rottingSteel": "RottingSteelLogo",
    "shadyCornerText": "Shady_Corner_Logo",
    "shcHoodie": "shcHoodie",
    "shcPanties": "shcPanties",
    "sheep": "Sheep",
    "silumanAlice": "siluman_Alice",
    "siluman": "siluman_logo",
    "sj68": "SJ68WHITE",
    "skull": "skull",
    "stilou": "Stilou",
    "strawberry": "Strawberry",
    "sylphy": "sylphy_chibi",
    "temple": "Temple",
    "tonisAlbum": "tonis album",
    "ufo": "ufo",
    "usb": "USP",
    "weeb": "WeebDesign",
    "withStupid": "WithStupid",
    "worldTamer": "world_tamer_logo",
    "wyldSpace": "WyldSpace",
    "xoulion": "XoulionLogo",
    "yaranaika": "yaranaika",
}

# PackedTexturesContainer sources for the limb crops, in
# mapping.json order
LIMB_CONTAINERS = {
    "experimental": [
        "experimentalLeftArm_interaction",
        "experimentalLeftLeg_interaction",
        "experimentalRightArm_interaction",
        "experimentalRightLeg_interaction",
    ],
    "hightech_skin": ["hightechHypercamoSkin_interact"],
}
LIMB_DIRS = {"experimental": "experimental", "hightech_skin": "hightech"}

# these add layer 1 to existing hair drawables. base hair is
# slot 0, so ColorIndex 1 gets the strand a seperate colour
# even though both layers end up on one Cubism drawable.
HAIR_STRAND_CONTAINERS = {
    "clothier": "clothierHairStrand_interaction",
    "eye_covering_bang": "eyecoveringbangStrand_interaction",
    "hime": "himeHairStrand_interaction",
}


def aligned_str(raw, off):
    n = struct.unpack_from("<I", raw, off)[0]
    s = raw[off + 4:off + 4 + n].decode()
    return s, (off + 4 + n + 3) & ~3


# a MonoBehaviour (unity's serialized component) puts m_Name
# after its 28-byte header
def mb_name(raw):
    return aligned_str(raw, 28)[0]


def parse_container(raw):
    # reverse engineered PackedTexturesContainer layout. after the
    # header and m_Name, each packed texture has a source name,
    # layer index and entry list. each entry is a drawable name,
    # bottom-left x/y/w/h and 3 more ints. then model names, the
    # Resources path, content hash and Texture2D size. source:
    # staring at hexdumps until it made sense.
    off = 28
    name, off = aligned_str(raw, off)
    ntex = struct.unpack_from("<I", raw, off)[0]
    off += 4
    sections = []
    for _ in range(ntex):
        _src, off = aligned_str(raw, off)
        layer = struct.unpack_from("<i", raw, off)[0]
        off += 4
        cnt = struct.unpack_from("<I", raw, off)[0]
        off += 4
        entries = {}
        for _ in range(cnt):
            en, off = aligned_str(raw, off)
            x, y, w, h, color_index, unknown, flag = struct.unpack_from(
                "<7i", raw, off)
            off += 28
            entries[en] = {
                "rect": (x, y, w, h),
                # PackedDrawable.ColorIndex -1 means this layer isn't tinted
                "color_index": color_index,
                # keep the two still-unidentified serialized fields in the
                # catalog so no game metadata gets silently thrown away
                "unknown": unknown,
                "flag": flag,
            }
        nmodels = struct.unpack_from("<I", raw, off)[0]
        off += 4
        for _ in range(nmodels):
            _m, off = aligned_str(raw, off)
        off += 4
        path, off = aligned_str(raw, off)
        _hash, off = aligned_str(raw, off)
        # the tail is byte size, 2 zeros and 2 ones
        off += 20
        sections.append({"source": _src, "layer": layer,
                         "entries": entries, "path": path})
    return name, sections


# UnityPy 1.10 renamed NamedObject.name to m_Name. android is
# pinned to 1.7.43, the last build without UnityPyBoost, so this
# file has to handle BOTH.
def obj_name(obj):
    name = getattr(obj, "m_Name", None)
    return name if name is not None else getattr(obj, "name", None)


# before 1.10 these are bare PPtrs (unity object references) in
# m_Components. later builds wrap them under m_Component. do NOT
# duck type here, old PPtrs forward unknown attributes straight
# to the object they point at, so every check comes back true.
def component_ptrs(game_object):
    entries = getattr(game_object, "m_Component", None)
    if entries is None:
        return list(game_object.m_Components)
    return [entry.component for entry in entries]


def safe_component(value):
    clean = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_") or "item"
    digest = hashlib.sha1(value.encode()).hexdigest()[:8]
    return f"{clean[:72]}_{digest}"


class Recovery:
    def __init__(self, game, out, atlas_size=None):
        data = os.path.join(game, "My Dystopian Robot Girlfriend_Data")
        if not os.path.isdir(data):
            sys.exit(f"game data dir not found: {data}")
        self.out = out
        self.atlas_size = atlas_size
        self.failures = []
        print("loading Unity files...")
        self.res = UnityPy.load(os.path.join(data, "resources.assets"))
        shared = UnityPy.load(os.path.join(data, "sharedassets0.assets"))
        self.shared = shared
        ggm = UnityPy.load(os.path.join(data, "globalgamemanagers"))
        self.res_objs = {o.path_id: o for o in self.res.objects}

        self.respath = {}
        for o in ggm.objects:
            if o.type.name == "ResourceManager":
                # before 1.10 this hands back a dict instead of key/PPtr pairs
                container = o.read().m_Container
                pairs = container.items() if isinstance(container, dict) else container
                for k, v in pairs:
                    self.respath[k] = v.path_id

        # the script lives in another file. grab its reference from a
        # container we already know, int64 at raw offset 20, then
        # collect every sibling with the same script.
        mbs = []
        script_id = None
        for o in shared.objects:
            if o.type.name != "MonoBehaviour":
                continue
            raw = bytes(o.get_raw_data())
            if len(raw) < 40:
                continue
            mbs.append(raw)
            if mb_name(raw) == "experimentalLeftArm_interaction":
                script_id = struct.unpack_from("<q", raw, 20)[0]
        if script_id is None:
            sys.exit("no PackedTexturesContainer found in sharedassets0.assets")
        self.containers = {}
        for raw in mbs:
            if struct.unpack_from("<q", raw, 20)[0] == script_id:
                name, secs = parse_container(raw)
                self.containers[name] = secs
        print(f"  {len(self.containers)} packed-texture containers")

    def save(self, img, rel):
        path = os.path.join(self.out, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img.save(path, "PNG")
        print("  wrote", rel)

    def tex_by_name(self, name):
        hits = [o.read() for o in self.res.objects
                if o.type.name == "Texture2D" and obj_name(o.read()) == name]
        if not hits:
            raise LookupError(f"no Texture2D named {name!r}")
        return max(hits, key=lambda t: t.m_Width * t.m_Height).image

    def tex_by_path(self, p):
        pid = self.respath.get(p.lower())
        if pid is not None and self.res_objs[pid].type.name == "Texture2D":
            return self.res_objs[pid].read().image
        # some paths point at the prefab instead of its texture.
        # fall back to the Texture2D with the same name.
        return self.tex_by_name(p.rsplit("/", 1)[-1])

    def attempt(self, what, fn):
        try:
            fn()
        except (LookupError, StopIteration) as e:
            self.failures.append(what)
            print(f"  SKIP {what}: {e}")

    def recover_moc3(self):
        for o in self.res.objects:
            if o.type.name != "MonoBehaviour":
                continue
            raw = bytes(o.get_raw_data())
            if mb_name(raw) != "interaction_model":
                continue
            i = raw.find(b"MOC3")
            if i > 3:
                size = struct.unpack_from("<I", raw, i - 4)[0]
                self.moc3 = raw[i:i + size]
                break
        else:
            sys.exit("interaction_model CubismMoc not found")
        os.makedirs(self.out, exist_ok=True)
        with open(os.path.join(self.out, "interaction_model.moc3"), "wb") as f:
            f.write(self.moc3)
        print("  wrote interaction_model.moc3")

        model3 = {
            "Version": 3,
            "FileReferences": {
                "Moc": "interaction_model.moc3",
                "Textures": ["texture_00.png", "texture_01.png", "texture_02.png"],
            },
            "Groups": [],
        }
        with open(os.path.join(self.out, "interaction_model.model3.json"), "w") as f:
            f.write(json.dumps(model3, indent=2))
        print("  wrote interaction_model.model3.json")

    def drawable_texture_slots(self):
        # moc3 v5 keeps the section pointer table at 0x40, art-mesh
        # IDs at slot 33 and texture numbers at slot 41
        moc = self.moc3
        u32 = lambda o: struct.unpack_from("<I", moc, o)[0]
        slot = lambda i: u32(0x40 + 4 * i)
        n_art = u32(slot(0) + 16)
        ids_p, texno_p = slot(33), slot(41)
        out = {}
        for k in range(n_art):
            nm = moc[ids_p + 64 * k:ids_p + 64 * k + 64].split(b"\0")[0].decode()
            out[nm] = u32(texno_p + 4 * k)
        return out

    def recover_atlases(self):
        # walk the interaction_model prefab. each drawable child's
        # CubismRenderer points at the Texture2D for its atlas slot.
        drawables = self.drawable_texture_slots()
        n_slots = max(drawables.values()) + 1
        model_go = next(
            o for o in self.res.objects
            if o.type.name == "GameObject" and obj_name(o.read()) == "interaction_model")

        def transform(go):
            for c in component_ptrs(go):
                o = self.res_objs[c.path_id]
                if o.type.name == "Transform":
                    return o.read()

        tex_ids = {o.path_id for o in self.res.objects if o.type.name == "Texture2D"}
        atlas = {}
        stack = [transform(model_go.read())]
        while stack and len(atlas) < n_slots:
            t = stack.pop()
            go = self.res_objs[t.m_GameObject.path_id].read()
            stack += [self.res_objs[c.path_id].read() for c in t.m_Children]
            go_name = obj_name(go)
            if go_name not in drawables or drawables[go_name] in atlas:
                continue
            for c in component_ptrs(go):
                o = self.res_objs[c.path_id]
                if o.type.name != "MonoBehaviour":
                    continue
                raw = bytes(o.get_raw_data())
                # CubismRenderer has 124 bytes here, with _mainTexture
                # path_id at offset 96
                if len(raw) != 124:
                    continue
                pid = struct.unpack_from("<q", raw, 96)[0]
                if pid in tex_ids:
                    atlas[drawables[go_name]] = pid
        if len(atlas) != n_slots:
            sys.exit(f"only resolved atlas slots {sorted(atlas)} of {n_slots}")
        for tn, pid in sorted(atlas.items()):
            img = self.res_objs[pid].read().image
            if self.atlas_size and self.atlas_size < img.width:
                # the atlases ARE the webapp's entire GPU budget. each
                # 4096 one costs 64 MB of VRAM uncompressed. UVs are
                # normalized and mipmaps are off, so the renderer
                # doesn't depend on this size.
                img = img.resize((self.atlas_size, self.atlas_size), Image.LANCZOS)
            self.save(img, f"texture_{tn:02d}.png")

    def recover_variants(self):
        def composite(out, cname):
            base = None
            for sec in self.containers[cname]:
                img = self.tex_by_path(sec["path"]).convert("RGBA")
                base = img if base is None else Image.alpha_composite(base, img)
            self.save(base, f"variants/{out}.png")

        def glasses(out, cname):
            base = None
            for sec in sorted(self.containers[cname], key=lambda s: s["layer"]):
                img = self.tex_by_path(sec["path"]).convert("RGBA")
                # keep lens and frame apart, the webapp tints them
                # seperately
                role = next(r for r in ("lens", "frame", "highlight", "heart")
                            if r in sec["path"].lower())
                self.save(img, f"variants/glasses/{out}_{role}.png")
                base = img if base is None else Image.alpha_composite(base, img)
            self.save(base, f"variants/{out}.png")

        for out, cname in VARIANTS.items():
            self.attempt(f"variants/{out}", lambda o=out, c=cname: composite(o, c))
        for out, tname in LOGOS.items():
            self.attempt(f"variants/{out}", lambda o=out, t=tname: self.save(
                self.tex_by_name(t), f"variants/{o}.png"))
        for out, cname in GLASSES.items():
            self.attempt(f"variants/{out}", lambda o=out, c=cname: glasses(o, c))

    def decal_by_name(self, name):
        # the registry stores decals as Sprites, so try those first.
        # fruit decals are rectangles in the Fruit+ atlas, and some
        # names collide with small unrelated sprites. the real decal
        # is ALWAYS the biggest one.
        for tname in ("Sprite", "Texture2D"):
            hits = [o.read() for env in (self.res, self.shared)
                    for o in env.objects
                    if o.type.name == tname and obj_name(o.read()) == name]
            if hits:
                return max(hits, key=lambda d: d.image.width * d.image.height).image
        raise LookupError(f"no Sprite or Texture2D named {name!r}")

    def recover_logos(self):
        for out, tname in DECALS.items():
            self.attempt(f"logos/{out}", lambda o=out, t=tname: self.save(
                self.decal_by_name(t), f"variants/logos/{o}.png"))

    def recover_limbs(self):
        mapping = {}
        for group, cnames in LIMB_CONTAINERS.items():
            d = LIMB_DIRS[group]
            mapping[group] = {}
            for cname in cnames:
                for sec in self.containers[cname]:
                    img = self.tex_by_path(sec["path"]).convert("RGBA")
                    _, H = img.size
                    for en, entry in sec["entries"].items():
                        x, y, w, h = entry["rect"]
                        # unity rectangles start at the BOTTOM left
                        crop = img.crop((x, H - y - h, x + w, H - y))
                        self.save(crop, f"variants/limbs/{d}/{en}.png")
                        mapping[group][en] = f"assets/variants/limbs/{d}/{en}.png"
        path = os.path.join(self.out, "variants", "limbs", "mapping.json")
        with open(path, "w") as f:
            f.write(json.dumps(mapping, indent=1) + "\n")
        print("  wrote variants/limbs/mapping.json")

    def recover_hair_strands(self):
        mapping = {}
        for key, cname in HAIR_STRAND_CONTAINERS.items():
            mapping[key] = []
            for sec_index, sec in enumerate(self.containers[cname]):
                img = self.tex_by_path(sec["path"]).convert("RGBA")
                _, height = img.size
                for drawable, entry in sec["entries"].items():
                    x, y, w, h = entry["rect"]
                    crop = img.crop((x, height - y - h, x + w, height - y))
                    rel = f"variants/hair/{key}/{drawable}.png"
                    self.save(crop, rel)
                    mapping[key].append({
                        "drawable": drawable,
                        "texture": f"assets/{rel}",
                        "layer": sec["layer"],
                        "color_index": entry["color_index"],
                        "section": sec_index,
                    })
        path = os.path.join(self.out, "variants", "hair", "mapping.json")
        with open(path, "w") as f:
            f.write(json.dumps(mapping, indent=1) + "\n")
        print("  wrote variants/hair/mapping.json")

    def recover_item_catalog(self):
        # keep every packed game item layer and its ColorIndex from
        # EVERY scene, not just the interaction model. texture
        # resource paths stay too, so later wardrobe work can crop
        # any native item without reverse engineering the binary all
        # over again.
        catalog = []
        for name, sections in sorted(self.containers.items()):
            color_indices = sorted({
                entry["color_index"]
                for sec in sections
                for entry in sec["entries"].values()
                if entry["color_index"] >= 0
            })
            catalog.append({
                "name": name,
                "key": safe_component(name),
                "color_indices": color_indices,
                "color_slot_count": max(color_indices, default=-1) + 1,
                "sections": [{
                    "source": sec["source"],
                    "resource": sec["path"],
                    "layer": sec["layer"],
                    "drawables": [{
                        "name": drawable,
                        "rect": list(entry["rect"]),
                        "color_index": entry["color_index"],
                        "unknown": entry["unknown"],
                        "flag": entry["flag"],
                    } for drawable, entry in sec["entries"].items()],
                } for sec in sections],
            })
        path = os.path.join(self.out, "variants", "game_items.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(json.dumps({"version": 1, "items": catalog}, indent=1) + "\n")
        print(f"  wrote variants/game_items.json ({len(catalog)} containers)")


def main():
    ap = argparse.ArgumentParser(description="Recover webapp/assets from the game install")
    ap.add_argument("--game", default=None, help="game install dir (default: auto-detect)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output assets dir")
    ap.add_argument("--atlas-size", type=int, default=None, metavar="PX",
                    help="downscale the base atlases to PX x PX (native 4096). "
                         "2048 cuts atlas VRAM from 192 MB to 48 MB")
    args = ap.parse_args()

    r = Recovery(args.game or find_game_dir(), args.out, args.atlas_size)
    print("model...");    r.recover_moc3()
    print("atlases...");  r.recover_atlases()
    print("variants..."); r.recover_variants()
    print("logos...");    r.recover_logos()
    print("limbs...");    r.recover_limbs()
    print("hair...");     r.recover_hair_strands()
    print("items...");    r.recover_item_catalog()
    if r.failures:
        print(f"\nWARNING: {len(r.failures)} item(s) not found in this game "
              "version and skipped:")
        print("  " + ", ".join(r.failures))
    print("done:", args.out)
    print()
    print("NOTE: these are the game's art assets, rebuilt for your own local")
    print("use. They belong to the creator of My Dystopian Robot Girlfriend -")
    print("please don't republish them (public fork, release, mirror). See the")
    print("NOTICE in LICENSE. (webapp/assets/ is gitignored so it won't push.)")


if __name__ == "__main__":
    main()
