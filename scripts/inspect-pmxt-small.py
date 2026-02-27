#!/usr/bin/env python3

"""
Inspect pmxt.dev Parquet data format (memory-efficient version)
"""

import sys
import pandas as pd
import pyarrow.parquet as pq

def inspect_parquet_light(filepath):
    print(f"\n=== INSPECTING: {filepath} ===\n")

    # Read Parquet schema without loading data
    parquet_file = pq.ParquetFile(filepath)

    print("=== SCHEMA ===")
    schema = parquet_file.schema_arrow
    for i, field in enumerate(schema):
        print(f"  {field.name}: {field.type}")

    print(f"\n=== METADATA ===")
    print(f"Number of rows: {parquet_file.metadata.num_rows:,}")
    print(f"Number of row groups: {parquet_file.metadata.num_row_groups}")
    print(f"Number of columns: {parquet_file.metadata.num_columns}")

    # Read ONLY first 1000 rows to save memory
    print("\n=== READING FIRST 1000 ROWS ===")
    df = pd.read_parquet(filepath, engine='pyarrow').head(1000)

    print(f"\nLoaded {len(df)} rows")
    print("\n=== SAMPLE DATA (first 5 rows) ===")
    print(df.head(5).to_string())

    print("\n=== COLUMN DTYPES ===")
    for col, dtype in df.dtypes.items():
        print(f"  {col}: {dtype}")

    print("\n=== KEY COLUMNS ANALYSIS ===")
    # Look for important columns
    if 'timestamp' in df.columns:
        print(f"Timestamp range: {df['timestamp'].min()} to {df['timestamp'].max()}")

    # Find ID-like columns
    id_cols = [col for col in df.columns if any(x in col.lower() for x in ['id', 'token', 'market', 'condition', 'slug'])]
    print(f"\nID-like columns: {id_cols}")

    for col in id_cols[:3]:  # First 3
        unique = df[col].nunique()
        print(f"\n{col}:")
        print(f"  Unique values: {unique}")
        if unique <= 5:
            print(f"  Values: {df[col].unique().tolist()}")
        else:
            print(f"  Sample: {df[col].unique()[:5].tolist()}")

    # Look for price columns
    price_cols = [col for col in df.columns if any(x in col.lower() for x in ['price', 'bid', 'ask', 'mid'])]
    print(f"\nPrice-like columns: {price_cols}")

    # Save sample to CSV for easier inspection
    csv_path = '/tmp/pmxt_sample.csv'
    df.head(100).to_csv(csv_path, index=False)
    print(f"\n✅ Saved first 100 rows to: {csv_path}")
    print("   You can inspect this with: cat /tmp/pmxt_sample.csv | head -20")

if __name__ == "__main__":
    filepath = sys.argv[1] if len(sys.argv) > 1 else '/tmp/sample.parquet'
    try:
        inspect_parquet_light(filepath)
    except MemoryError:
        print("\n❌ Out of memory. File too large for container.")
        print("Consider running this on the host machine instead.")
        sys.exit(1)
