#!/usr/bin/env python3

"""
Inspect pmxt.dev Parquet data format
"""

import sys
import pandas as pd
import pyarrow.parquet as pq

def inspect_parquet(filepath):
    print(f"\n=== INSPECTING: {filepath} ===\n")

    # Read Parquet schema without loading all data
    parquet_file = pq.ParquetFile(filepath)

    print("=== SCHEMA ===")
    print(parquet_file.schema)

    print(f"\n=== METADATA ===")
    print(f"Number of rows: {parquet_file.metadata.num_rows:,}")
    print(f"Number of row groups: {parquet_file.metadata.num_row_groups}")
    print(f"Number of columns: {parquet_file.metadata.num_columns}")

    # Read first 10 rows
    print("\n=== SAMPLE DATA (first 10 rows) ===")
    df = pd.read_parquet(filepath, engine='pyarrow')
    print(df.head(10))

    print("\n=== COLUMN DTYPES ===")
    print(df.dtypes)

    print("\n=== COLUMN STATISTICS ===")
    print(df.describe())

    print("\n=== UNIQUE VALUES IN KEY COLUMNS ===")
    # Check for columns that might identify markets
    potential_id_cols = [col for col in df.columns if any(x in col.lower() for x in ['id', 'token', 'market', 'condition'])]
    for col in potential_id_cols[:5]:  # First 5 ID-like columns
        unique_count = df[col].nunique()
        print(f"{col}: {unique_count} unique values")
        if unique_count <= 10:
            print(f"  Values: {df[col].unique().tolist()}")

    print("\n=== ANALYSIS ===")
    print("Key findings:")
    print(f"  - Total markets/tokens tracked: {df[potential_id_cols[0]].nunique() if potential_id_cols else 'Unknown'}")
    print(f"  - Time range: {df['timestamp'].min() if 'timestamp' in df.columns else 'N/A'} to {df['timestamp'].max() if 'timestamp' in df.columns else 'N/A'}")
    print(f"  - Snapshot count: {len(df):,}")

if __name__ == "__main__":
    filepath = sys.argv[1] if len(sys.argv) > 1 else '/tmp/sample.parquet'
    inspect_parquet(filepath)
