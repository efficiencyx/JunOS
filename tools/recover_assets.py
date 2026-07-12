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
  variants/limbs/**             per-drawable crops of the packed variant
                                textures (Experimental limbs + High-Tech
                                skin), with mapping.json for outfit.js

Usage:
  python3 tools/recover_assets.py [--game DIR] [--out DIR]

Requires: UnityPy, Pillow  (pip install UnityPy Pillow)
"""

import argparse
import json
import os
import struct
import sys

from PIL import Image
import UnityPy

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Linux and Windows builds ship identical Unity data; use whichever exists.
GAME_CANDIDATES = [
    os.path.expanduser("~/Documenti/factorial-omega-linux-64"),
    os.path.expanduser("~/Documenti/factorial-omega-win-64"),
]
DEFAULT_OUT = os.path.join(REPO, "webapp", "assets")


def find_game_dir():
    for d in GAME_CANDIDATES:
        if os.path.isdir(os.path.join(d, "My Dystopian Robot Girlfriend_Data")):
            return d
    sys.exit("no game install found; pass --game DIR")

# Container name -> output PNG for the clothing variant swaps in outfit.js.
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

# Output PNG -> Texture2D name for the standalone logo decals.
LOGOS = {
    "logoGamerTshirt": "GamerTshirt",
    "logoPriestbot": "priestbot_tshirt",
    "logoShcHoodie": "shcHoodie",
    "logoShcPanties": "shcPanties",
}

# PackedTexturesContainer sources for the limb crops, in mapping.json order.
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


def aligned_str(raw, off):
    n = struct.unpack_from("<I", raw, off)[0]
    s = raw[off + 4:off + 4 + n].decode()
    return s, (off + 4 + n + 3) & ~3


def mb_name(raw):
    """m_Name of a MonoBehaviour from its raw bytes (header is
    GameObject PPtr + enabled + script PPtr = 28 bytes)."""
    return aligned_str(raw, 28)[0]


def parse_container(raw):
    """Parse a PackedTexturesContainer MonoBehaviour.

    Layout (reverse engineered): after the MB header and m_Name comes a
    packed-texture array; each element is the source art name, a layer
    index, the entry list (drawable name + x/y/w/h rect from the
    bottom-left + 3 ints), the model-name list, and the Resources path,
    content hash and size of the packed Texture2D.
    """
    off = 28
    name, off = aligned_str(raw, off)
    ntex = struct.unpack_from("<I", raw, off)[0]
    off += 4
    sections = []
    for _ in range(ntex):
        _src, off = aligned_str(raw, off)
        off += 4  # layer index
        cnt = struct.unpack_from("<I", raw, off)[0]
        off += 4
        entries = {}
        for _ in range(cnt):
            en, off = aligned_str(raw, off)
            x, y, w, h = struct.unpack_from("<4i", raw, off)
            off += 16 + 12  # rect + 3 unknown ints
            entries[en] = (x, y, w, h)
        nmodels = struct.unpack_from("<I", raw, off)[0]
        off += 4
        for _ in range(nmodels):
            _m, off = aligned_str(raw, off)
        off += 4
        path, off = aligned_str(raw, off)
        _hash, off = aligned_str(raw, off)
        off += 20  # byte size + 2 zeros + 2 ones
        sections.append({"entries": entries, "path": path})
    return name, sections


class Recovery:
    def __init__(self, game, out):
        data = os.path.join(game, "My Dystopian Robot Girlfriend_Data")
        if not os.path.isdir(data):
            sys.exit(f"game data dir not found: {data}")
        self.out = out
        print("loading Unity files...")
        self.res = UnityPy.load(os.path.join(data, "resources.assets"))
        shared = UnityPy.load(os.path.join(data, "sharedassets0.assets"))
        ggm = UnityPy.load(os.path.join(data, "globalgamemanagers"))
        self.res_objs = {o.path_id: o for o in self.res.objects}

        # Resources path (lowercase) -> path_id, from the ResourceManager.
        self.respath = {}
        for o in ggm.objects:
            if o.type.name == "ResourceManager":
                for k, v in o.read().m_Container:
                    self.respath[k] = v.path_id

        # Every PackedTexturesContainer. The script itself lives in another
        # file, so identify the script reference (int64 at raw offset 20)
        # from a container we know by name, then collect its siblings.
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

    # -- helpers ---------------------------------------------------------

    def save(self, img, rel):
        path = os.path.join(self.out, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img.save(path, "PNG")
        print("  wrote", rel)

    def tex_by_name(self, name):
        hits = [o for o in self.res.objects
                if o.type.name == "Texture2D" and o.read().m_Name == name]
        if len(hits) != 1:
            sys.exit(f"expected exactly one Texture2D named {name!r}, got {len(hits)}")
        return hits[0].read().image

    def tex_by_path(self, p):
        pid = self.respath.get(p.lower())
        if pid is not None and self.res_objs[pid].type.name == "Texture2D":
            return self.res_objs[pid].read().image
        # A few container paths point at the prefab instead of the texture;
        # fall back to the equally-named Texture2D.
        return self.tex_by_name(p.rsplit("/", 1)[-1])

    # -- steps -----------------------------------------------------------

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
        """drawable name -> atlas slot, parsed from the moc3 (v5 layout;
        section pointer table at 0x40, art-mesh ids at slot 33 and
        texture numbers at slot 41)."""
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
        """Walk the interaction_model prefab; each drawable child's
        CubismRenderer holds the Texture2D for that drawable's atlas slot."""
        drawables = self.drawable_texture_slots()
        n_slots = max(drawables.values()) + 1
        model_go = next(
            o for o in self.res.objects
            if o.type.name == "GameObject" and o.read().m_Name == "interaction_model")

        def transform(go):
            for c in go.m_Component:
                o = self.res_objs[c.component.path_id]
                if o.type.name == "Transform":
                    return o.read()

        tex_ids = {o.path_id for o in self.res.objects if o.type.name == "Texture2D"}
        atlas = {}
        stack = [transform(model_go.read())]
        while stack and len(atlas) < n_slots:
            t = stack.pop()
            go = self.res_objs[t.m_GameObject.path_id].read()
            stack += [self.res_objs[c.path_id].read() for c in t.m_Children]
            if go.m_Name not in drawables or drawables[go.m_Name] in atlas:
                continue
            for c in go.m_Component:
                o = self.res_objs[c.component.path_id]
                if o.type.name != "MonoBehaviour":
                    continue
                raw = bytes(o.get_raw_data())
                if len(raw) != 124:  # CubismRenderer: _mainTexture path_id at 96
                    continue
                pid = struct.unpack_from("<q", raw, 96)[0]
                if pid in tex_ids:
                    atlas[drawables[go.m_Name]] = pid
        if len(atlas) != n_slots:
            sys.exit(f"only resolved atlas slots {sorted(atlas)} of {n_slots}")
        for tn, pid in sorted(atlas.items()):
            self.save(self.res_objs[pid].read().image, f"texture_{tn:02d}.png")

    def recover_variants(self):
        for out, cname in VARIANTS.items():
            base = None
            for sec in self.containers[cname]:
                img = self.tex_by_path(sec["path"]).convert("RGBA")
                base = img if base is None else Image.alpha_composite(base, img)
            self.save(base, f"variants/{out}.png")
        for out, tname in LOGOS.items():
            self.save(self.tex_by_name(tname), f"variants/{out}.png")

    def recover_limbs(self):
        mapping = {}
        for group, cnames in LIMB_CONTAINERS.items():
            d = LIMB_DIRS[group]
            mapping[group] = {}
            for cname in cnames:
                for sec in self.containers[cname]:
                    img = self.tex_by_path(sec["path"]).convert("RGBA")
                    _, H = img.size
                    for en, (x, y, w, h) in sec["entries"].items():
                        # rects are stored from the bottom-left
                        crop = img.crop((x, H - y - h, x + w, H - y))
                        self.save(crop, f"variants/limbs/{d}/{en}.png")
                        mapping[group][en] = f"assets/variants/limbs/{d}/{en}.png"
        path = os.path.join(self.out, "variants", "limbs", "mapping.json")
        with open(path, "w") as f:
            f.write(json.dumps(mapping, indent=1) + "\n")
        print("  wrote variants/limbs/mapping.json")


def main():
    ap = argparse.ArgumentParser(description="Recover webapp/assets from the game install")
    ap.add_argument("--game", default=None, help="game install dir (default: auto-detect)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output assets dir")
    args = ap.parse_args()

    r = Recovery(args.game or find_game_dir(), args.out)
    print("model...");    r.recover_moc3()
    print("atlases...");  r.recover_atlases()
    print("variants..."); r.recover_variants()
    print("limbs...");    r.recover_limbs()
    print("done:", args.out)
    print()
    print("NOTE: these are the game's art assets, rebuilt for your own local")
    print("use. They belong to the creator of My Dystopian Robot Girlfriend -")
    print("please don't republish them (public fork, release, mirror). See the")
    print("NOTICE in LICENSE. (webapp/assets/ is gitignored so it won't push.)")


if __name__ == "__main__":
    main()
