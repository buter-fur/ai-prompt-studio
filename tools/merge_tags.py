#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 scratch/frag-*.json 片段合并进 app/data/tags.json。

合并规则：
- 分类：按 id 匹配，已存在则复用，不存在则整体追加
- 分组：按 id 匹配，已存在则复用，不存在则追加到该分类末尾
- 标签：按 en（小写）全局去重，保留先出现的那个

这样子代理无论「只给新增词」还是「重列原有词 + 新增词」，结果都正确。
"""

import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)
TAGS_FILE = os.path.join(ROOT, "app", "data", "tags.json")

ORDER = [
    "frag-scene.json",
    "frag-character.json",
    "frag-color-style.json",
    "frag-quality-camera.json",
    "frag-mood-functional.json",
    "frag-negative-animals-plants.json",
    "frag-food-objects-fx.json",
    "frag-era-medium-type.json",
]


def tag_total(categories):
    return sum(len(g.get("tags", [])) for c in categories for g in c.get("groups", []))


def main():
    with open(TAGS_FILE, encoding="utf-8") as handle:
        data = json.load(handle)
    categories = data["categories"]
    by_id = {c["id"]: c for c in categories}

    seen_en = {}
    for cat in categories:
        for group in cat.get("groups", []):
            for tag in group.get("tags", []):
                seen_en.setdefault(tag["en"].lower(), (cat["id"], group["id"]))

    before = tag_total(categories)
    report = []

    for name in ORDER:
        path = os.path.join(BASE, name)
        if not os.path.exists(path):
            print("  [跳过] %s 不存在" % name)
            continue

        with open(path, encoding="utf-8") as handle:
            fragment = json.load(handle)
        if isinstance(fragment, dict):
            fragment = fragment.get("categories", [])

        added_total = 0
        for frag_cat in fragment:
            cid = frag_cat.get("id")
            if not cid:
                continue
            if cid not in by_id:
                new_cat = {
                    "id": cid,
                    "name": frag_cat.get("name", cid),
                    "nameEn": frag_cat.get("nameEn", ""),
                    "icon": frag_cat.get("icon", "•"),
                    "groups": [],
                }
                if frag_cat.get("negative"):
                    new_cat["negative"] = True
                categories.append(new_cat)
                by_id[cid] = new_cat

            cat = by_id[cid]
            for frag_group in frag_cat.get("groups", []):
                gid = frag_group.get("id")
                if not gid:
                    continue
                group = next((g for g in cat["groups"] if g["id"] == gid), None)
                if group is None:
                    group = {
                        "id": gid,
                        "name": frag_group.get("name", ""),
                        "nameEn": frag_group.get("nameEn", ""),
                        "tags": [],
                    }
                    cat["groups"].append(group)

                added = 0
                for tag in frag_group.get("tags", []):
                    zh = str(tag.get("zh", "")).strip()
                    en = str(tag.get("en", "")).strip()
                    if not zh or not en:
                        continue
                    key = en.lower()
                    if key in seen_en:
                        continue
                    seen_en[key] = (cid, gid)
                    group["tags"].append({"zh": zh, "en": en})
                    added += 1
                if added:
                    report.append((name, cid, gid, added))
                    added_total += added

        print("  [合并] %-34s 新增 %3d 个标签" % (name, added_total))

    data["version"] = data.get("version", 1) + 1
    with open(TAGS_FILE, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    after = tag_total(categories)
    print("\n分类 %d 个 | 分组 %d 个 | 标签 %d → %d（新增 %d）"
          % (len(categories),
             sum(len(c["groups"]) for c in categories),
             before, after, after - before))

    empties = [(c["id"], g["id"]) for c in categories for g in c["groups"] if not g["tags"]]
    if empties:
        print("空分组：%s" % empties)

    # 检查 en 是否还有重复（理论上不会有）
    counter = {}
    for cat in categories:
        for group in cat["groups"]:
            for tag in group["tags"]:
                counter[tag["en"].lower()] = counter.get(tag["en"].lower(), 0) + 1
    dup = {k: v for k, v in counter.items() if v > 1}
    print("重复 en：%s" % (dup if dup else "无"))

    for cat in categories:
        n = sum(len(g["tags"]) for g in cat["groups"])
        print("  %-14s %-12s %4d 个标签 / %2d 组" % (cat["id"], cat["name"], n, len(cat["groups"])))

    return 0 if not dup else 1


if __name__ == "__main__":
    sys.exit(main())
