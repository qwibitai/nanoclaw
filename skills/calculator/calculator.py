#!/usr/bin/env python3
"""
計算器 Skill - 示範基本數學運算

名稱: calculator
描述: 執行基本數學運算（加減乘除、次方、平方根等）
版本: 1.0.0
"""

import sys
import json
import argparse
import math
from typing import Any

def calculate(expression: str = None, operation: str = None,
              num1: float = None, num2: float = None) -> dict:
    """
    執行數學運算

    Args:
        expression: 數學表達式（如果提供，會優先使用）
        operation: 運算類型 (add, subtract, multiply, divide, power, sqrt)
        num1: 第一個數字
        num2: 第二個數字（某些運算不需要）

    Returns:
        包含計算結果的字典
    """
    try:
        # 如果提供表達式，使用 eval（安全性受限）
        if expression:
            # 限制可用的函數以提高安全性
            safe_dict = {
                'abs': abs, 'round': round, 'min': min, 'max': max,
                'pow': pow, 'sqrt': math.sqrt, 'sin': math.sin,
                'cos': math.cos, 'tan': math.tan, 'pi': math.pi,
                'e': math.e
            }
            result = eval(expression, {"__builtins__": {}}, safe_dict)
            return {
                "success": True,
                "result": f"{expression} = {result}",
                "data": {
                    "expression": expression,
                    "answer": result
                }
            }

        # 使用運算類型和數字
        if operation and num1 is not None:
            operations = {
                'add': lambda a, b: a + b,
                'subtract': lambda a, b: a - b,
                'multiply': lambda a, b: a * b,
                'divide': lambda a, b: a / b if b != 0 else None,
                'power': lambda a, b: a ** b,
                'sqrt': lambda a, _: math.sqrt(a),
                'square': lambda a, _: a ** 2,
                'abs': lambda a, _: abs(a)
            }

            if operation not in operations:
                return {
                    "success": False,
                    "error": f"不支援的運算: {operation}"
                }

            # 單參數運算
            if operation in ['sqrt', 'square', 'abs']:
                result = operations[operation](num1, None)
            else:
                if num2 is None:
                    return {
                        "success": False,
                        "error": f"{operation} 需要兩個數字"
                    }
                result = operations[operation](num1, num2)

            if result is None:
                return {
                    "success": False,
                    "error": "除數不能為零"
                }

            return {
                "success": True,
                "result": f"結果: {result}",
                "data": {
                    "operation": operation,
                    "num1": num1,
                    "num2": num2,
                    "answer": result
                }
            }

        return {
            "success": False,
            "error": "請提供表達式或運算類型與數字"
        }

    except ZeroDivisionError:
        return {
            "success": False,
            "error": "除數不能為零"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"計算錯誤: {str(e)}"
        }

def main(args: argparse.Namespace) -> dict:
    """主要執行函數"""
    return calculate(
        expression=args.expression,
        operation=args.operation,
        num1=args.num1,
        num2=args.num2
    )

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='執行數學運算')

    parser.add_argument('-e', '--expression', type=str, help='數學表達式（例如: "2 + 3 * 4"）')
    parser.add_argument('-o', '--operation', type=str,
                       choices=['add', 'subtract', 'multiply', 'divide', 'power', 'sqrt', 'square', 'abs'],
                       help='運算類型')
    parser.add_argument('-n1', '--num1', type=float, help='第一個數字')
    parser.add_argument('-n2', '--num2', type=float, help='第二個數字')
    parser.add_argument('--json', action='store_true', help='以 JSON 格式輸出結果')

    args = parser.parse_args()
    result = main(args)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result['success']:
            print(result['result'])
            if 'data' in result and 'answer' in result['data']:
                print(f"答案: {result['data']['answer']}")
        else:
            print(f"錯誤: {result['error']}", file=sys.stderr)
            sys.exit(1)
