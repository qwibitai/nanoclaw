---
name: calculator
description: 執行基本數學運算，包括加減乘除、次方、平方根、三角函數等。支援數學表達式或單獨運算。
---

# 計算器

執行各種數學運算的 skill。

## 功能

- **表達式計算**: 輸入完整的數學表達式
- **基本運算**: 加、減、乘、除
- **進階運算**: 次方、平方根、絕對值
- **數學函數**: sin, cos, tan, sqrt, pow
- **數學常數**: pi, e

## 使用方式

### 方式 1: 使用表達式

```bash
python3 /workspace/project/.claude/skills/calculator/calculator.py \
  --expression "sqrt(144) + pow(2, 3)" \
  --json
```

### 方式 2: 使用運算類型

```bash
python3 /workspace/project/.claude/skills/calculator/calculator.py \
  --operation sqrt \
  --num1 25 \
  --json
```

## 參數

- `--expression` / `-e`: 數學表達式（優先使用）
- `--operation` / `-o`: 運算類型
  - `add`: 加法
  - `subtract`: 減法
  - `multiply`: 乘法
  - `divide`: 除法
  - `power`: 次方
  - `sqrt`: 平方根
  - `square`: 平方
  - `abs`: 絕對值
- `--num1` / `-n1`: 第一個數字
- `--num2` / `-n2`: 第二個數字（某些運算不需要）
- `--json`: 以 JSON 格式輸出

## 輸出格式

```json
{
  "success": true,
  "result": "sqrt(144) + pow(2, 3) = 20.0",
  "data": {
    "expression": "sqrt(144) + pow(2, 3)",
    "answer": 20.0
  }
}
```

## 範例

```bash
# 計算表達式
python3 calculator.py -e "2 + 3 * 4" --json

# 平方根
python3 calculator.py -o sqrt -n1 16 --json

# 加法
python3 calculator.py -o add -n1 10 -n2 5 --json

# 次方
python3 calculator.py -o power -n1 2 -n2 8 --json
```

## 安全性

表達式計算使用受限的 `eval()` 環境，僅允許安全的數學函數和常數。
