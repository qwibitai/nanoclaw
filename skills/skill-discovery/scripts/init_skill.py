#!/usr/bin/env python3
"""
Initialize a new skill structure

Usage:
    python3 init_skill.py <skill-name> [--description "Skill description"]
"""

import sys
import os
import argparse
from pathlib import Path
from datetime import datetime

SKILL_TEMPLATE = """---
name: {skill_name}
description: {description}
---

# {skill_title}

{detailed_description}

## 使用方式

```bash
python3 /workspace/project/.claude/skills/{skill_name}/script.py --param value
```

## 參數

- `--param`: Parameter description

## 輸出格式

```json
{{
  "success": true,
  "result": "...",
  "data": {{...}}
}}
```

## 範例

```bash
# Example usage
python3 script.py --param value --json
```
"""

SCRIPT_TEMPLATE = """#!/usr/bin/env python3
\"\"\"
{skill_title} - {description}

Created: {created_date}
\"\"\"

import sys
import json
import argparse
from typing import Dict, Any

def main(args: argparse.Namespace) -> Dict[str, Any]:
    \"\"\"主要執行函數\"\"\"
    try:
        # TODO: 實現功能
        return {{
            "success": True,
            "result": "功能執行成功",
            "data": {{}}
        }}
    except Exception as e:
        return {{
            "success": False,
            "error": str(e)
        }}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='{description}')

    # TODO: 添加參數
    # parser.add_argument('--param', type=str, help='Parameter description')

    parser.add_argument('--json', action='store_true', help='以 JSON 格式輸出')

    args = parser.parse_args()
    result = main(args)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result['success']:
            print(result['result'])
        else:
            print(f"錯誤: {{result['error']}}", file=sys.stderr)
            sys.exit(1)
"""

def init_skill(skill_name: str, description: str, base_path: str = "/workspace/project/.claude/skills"):
    """初始化新的 skill 結構"""

    # 創建 skill 目錄
    skill_path = Path(base_path) / skill_name
    skill_path.mkdir(parents=True, exist_ok=True)

    print(f"📁 創建目錄: {skill_path}")

    # 創建子目錄
    (skill_path / "scripts").mkdir(exist_ok=True)
    (skill_path / "references").mkdir(exist_ok=True)
    (skill_path / "assets").mkdir(exist_ok=True)

    # 生成 SKILL.md
    skill_title = skill_name.replace("-", " ").title()
    skill_md_content = SKILL_TEMPLATE.format(
        skill_name=skill_name,
        skill_title=skill_title,
        description=description,
        detailed_description=f"詳細說明 {skill_title} 的功能和用途。"
    )

    skill_md_path = skill_path / "SKILL.md"
    skill_md_path.write_text(skill_md_content, encoding='utf-8')
    print(f"✓ 創建: SKILL.md")

    # 生成主腳本
    script_content = SCRIPT_TEMPLATE.format(
        skill_title=skill_title,
        description=description,
        created_date=datetime.now().strftime("%Y-%m-%d")
    )

    script_path = skill_path / f"{skill_name.replace('-', '_')}.py"
    script_path.write_text(script_content, encoding='utf-8')
    script_path.chmod(0o755)
    print(f"✓ 創建: {script_path.name}")

    # 創建 README
    readme_content = f"""# {skill_title}

{description}

## 開發

這個 skill 使用 skill-discovery 的 init_skill.py 創建。

編輯 `SKILL.md` 來定義 Claude 如何使用這個 skill。
編輯 `{script_path.name}` 來實現功能邏輯。

## 測試

```bash
python3 {script_path.name} --json
```
"""

    readme_path = skill_path / "README.md"
    readme_path.write_text(readme_content, encoding='utf-8')
    print(f"✓ 創建: README.md")

    print(f"\n✅ Skill '{skill_name}' 初始化完成！")
    print(f"\n下一步：")
    print(f"  1. 編輯 {skill_path}/SKILL.md")
    print(f"  2. 實現 {skill_path}/{script_path.name}")
    print(f"  3. 測試: python3 {skill_path}/{script_path.name} --json")

    return str(skill_path)

def main():
    parser = argparse.ArgumentParser(description='初始化新的 skill')
    parser.add_argument('skill_name', help='Skill 名稱（使用 kebab-case）')
    parser.add_argument('--description', '-d', default='A new skill', help='Skill 描述')
    parser.add_argument('--base-path', default='/workspace/project/.claude/skills', help='Skills 基礎路徑')

    args = parser.parse_args()

    # 驗證名稱格式
    if not all(c.islower() or c == '-' or c.isdigit() for c in args.skill_name):
        print("❌ 錯誤: Skill 名稱必須使用 kebab-case（小寫字母、數字和連字號）", file=sys.stderr)
        sys.exit(1)

    try:
        init_skill(args.skill_name, args.description, args.base_path)
    except Exception as e:
        print(f"❌ 錯誤: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
