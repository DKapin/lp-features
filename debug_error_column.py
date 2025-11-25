"""
Debug script to find where the ERROR column is coming from
"""
import pandas as pd

# Load the landing page features file
print("="*80)
print("DEBUGGING: Looking for ERROR column")
print("="*80)

df = pd.read_csv('landing_page_features.csv')

print(f"\n1. Loaded landing_page_features.csv")
print(f"   Shape: {df.shape}")
print(f"   Columns: {len(df.columns)}")

# Check if ERROR column exists
if 'ERROR' in df.columns:
    print("\n   ⚠️  ERROR COLUMN FOUND!")
    print(f"   Missing values in ERROR: {df['ERROR'].isnull().sum()}")
    print(f"   Non-null values in ERROR: {df['ERROR'].notna().sum()}")

    # Show what's in ERROR column
    print("\n   Sample ERROR values:")
    print(df[['URL', 'ERROR']].head(10))
else:
    print("\n   ✅ NO ERROR COLUMN in landing_page_features.csv")

# List all columns
print("\n2. All columns in the file:")
for i, col in enumerate(df.columns, 1):
    print(f"   {i:3d}. {col}")

# Check for any unusual column names
print("\n3. Looking for unusual column names:")
unusual = [col for col in df.columns if any(char in col.lower() for char in ['error', 'fail', 'problem', 'issue'])]
if unusual:
    print(f"   Found: {unusual}")
else:
    print("   ✅ No unusual columns found")

# Check missing values summary
print("\n4. Missing values summary (top 10):")
missing = df.isnull().sum()
if missing.sum() > 0:
    print(missing[missing > 0].sort_values(ascending=False).head(10))
else:
    print("   ✅ No missing values!")
