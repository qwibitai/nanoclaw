#!/usr/bin/env python3
"""
驗證 skill 的結構和內容是否符合規範

Usage:
    python3 validate_skill.py <skill-path>
"""

import sys
import argparse
from pathlib import Path
import re

def validate_skill(skill_path: Path) -> tuple[bool, list[str]]:
    """驗證 skill 結構"""

    errors = []
    warnings = []

    # 檢查 SKILL.md 存在
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        errors.append("❌ 缺少 SKILL.md 檔案")
        return False, errors

    # 讀取內容
    content = skill_md.read_text(encoding='utf-8')

    # 檢查 frontmatter
    if not content.startswith('---'):
        errors.append("❌ SKILL.md 必須以 YAML frontmatter 開頭")
    else:
        # 提取 frontmatter
        try:
            end_idx = content.index('---', 3)
            frontmatter = content[3:end_idx]

            # 檢查必要欄位
            if 'name:' not in frontmatter:
                errors.append("❌ frontmatter 缺少 'name' 欄位")
            if 'description:' not in frontmatter:
                errors.append("❌ frontmatter 缺少 'description' 欄位")

            # 檢查 description 長度
            desc_match = re.search(r'description:\s*(.+)', frontmatter)
            if desc_match:
                desc = desc_match.group(1).strip()
                if len(desc) < 20:
                    warnings.append("⚠️  description 太短，建議至少 20 字元")
                if len(desc) > 200:
                    warnings.append("⚠️  description 太長，建議不超過 200 字元")

        except ValueError:
            errors.append("❌ YAML frontmatter 格式錯誤（缺少結束的 ---）")

    # 檢查內容結構
    if '# ' not in content:
        warnings.append("⚠️  建議包含標題（# Heading）")

    if '## ' not in content:
        warnings.append("⚠️  建議包含子標題（## Subheading）")

    # 檢查是否有使用範例
    if '```' not in content:
        warnings.append("⚠️  建議包含程式碼範例")

    # 檢查目錄結構
    if (skill_path / "scripts").exists():
        script_count = len(list((skill_path / "scripts").glob("*.py")))
        if script_count > 0:
            print(f"✓ 找到 {script_count} 個腳本")

    if (skill_path / "references").exists():
        ref_count = len(list((skill_path / "references").iterdir()))
        if ref_count > 0:
            print(f"✓ 找到 {ref_count} 個參考文件")

    # 檢查可執行腳本
    for script in skill_path.glob("*.py"):
        if not script.stat().st_mode & 0o111:
            warnings.append(f"⚠️  {script.name} 不是可執行的")

    return len(errors) == 0, errors + warnings

def main():
    parser = argparse.ArgumentParser(description='驗證 skill 結構')
    parser.add_argument('skill_path', help='Skill 目錄路徑')

    args = parser.parse_args()
    skill_path = Path(args.skill_path)

    if not skill_path.exists():
        print(f"❌ 錯誤: 路徑不存在: {skill_path}", file=sys.stderr)
        sys.exit(1)

    if not skill_path.is_dir():
        print(f"❌ 錯誤: 不是目錄: {skill_path}", file=sys.stderr)
        sys.exit(1)

    print(f"📋 驗證 skill: {skill_path.name}\n")

    is_valid, messages = validate_skill(skill_path)

    for msg in messages:
        print(msg)

    print()
    if is_valid:
        print("✅ Skill 驗證通過！")
        sys.exit(0)
    else:
        print("❌ Skill 驗證失敗")
        sys.exit(1)

if __name__ == "__main__":
    main()
