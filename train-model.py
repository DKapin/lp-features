# train_vcvr_model.py
#
# Goal:
#   - Train a regression model to predict VCVR from landing-page features.
#   - Handle missing data in a principled way.
#   - Treat SEMrush domain RANK specially (missing data ≠ zero/average).
#
# Assumptions:
#   - Your CSV has a column "VCVR" (target) and "URL" (ID).
#   - SEMrush domain rank column is named "RANK".
#   - File path may need to be changed to where your real data lives.

import pandas as pd
import numpy as np
from pathlib import Path

from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
from xgboost import XGBRegressor
import joblib


# -------- CONFIG --------
# Change this path to your real dataset location.
DATA_PATH = Path("/mnt/data/landing_page_features.csv")

TARGET_COL = "VCVR"
ID_COLS = ["URL"]      # columns that are identifiers / not real features
MODEL_PATH = Path("vcvr_xgb_model.joblib")

INTERNAL_FLAG_COL = "IsInternal"   # change if your column has a different name



def load_data(path: Path) -> pd.DataFrame:
    """Load raw dataset from CSV."""
    df = pd.read_csv(path)

    if TARGET_COL not in df.columns:
        raise ValueError(f"Target column '{TARGET_COL}' not found in dataset.")

    print(f"Loaded raw dataset with shape: {df.shape}")
    return df


def clean_and_impute(df: pd.DataFrame):
    """
    Handle:
      - dropping bad rows
      - dropping unusable columns
      - filling missing values (imputation)
      - special logic for SEMrush domain rank ("RANK")

    Returns:
      X (features),
      y (target),
      imputation_info (dict with metadata about how we handled missingness)
    """

    df = df.copy()

    # === 1. DROP ROWS WITH MISSING TARGET =========================
    # If we don't know the VCVR for a row, we can't use it for supervised training.
    before_rows = len(df)
    df = df[df[TARGET_COL].notnull()]
    after_rows = len(df)
    print(f"Dropped {before_rows - after_rows} rows with missing {TARGET_COL}.")

    # OPTIONAL: You may also want to drop rows with extremely low Clicks,
    # because VCVR for those rows is very noisy. Example:
    # min_clicks = 30
    # if "Clicks" in df.columns:
    #     before_rows = len(df)
    #     df = df[df["Clicks"] >= min_clicks]
    #     print(f"Dropped {before_rows - len(df)} rows with Clicks < {min_clicks}.")

    # === 2. SPECIAL HANDLING FOR SEMRUSH DOMAIN RANK ===============
    # We assume this column is named "RANK".
    # Missing RANK does NOT mean 0 or average; it means "no SEMrush data".
    # Strategy:
    #   - Create a missing-indicator column: RANK_missing (0/1)
    #   - Fill missing RANK values with a sentinel value (-1)
    #   - Exclude RANK from generic imputation below (we've already handled it)
    sentinel_cols = {}
    if "RANK" in df.columns:
        # Create a missing flag (model can learn if "no SEMrush data" matters)
        df["RANK_missing"] = df["RANK"].isnull().astype(int)

        # Sentinel value for missing ranks
        sentinel_value = -1
        df["RANK"] = df["RANK"].fillna(sentinel_value)
        sentinel_cols["RANK"] = sentinel_value

        print("Applied sentinel imputation to 'RANK' and created 'RANK_missing' flag.")
        # Note: RANK is now fully populated and should NOT be further imputed later.


        # === CATEGORY-LEVEL STATS ==============================
        # We create numeric features summarizing how this category performs overall.
        # NOTE: This uses the full dataset, which is fine for a first version.
        # For very strict leakage control, you could recompute these inside
        # the train/validation split later.
        if "Category" in df.columns:
            cat_stats = (
                df.groupby("Category")[TARGET_COL]
                  .agg(
                      cat_mean_vcvr="mean",
                      cat_median_vcvr="median",
                      cat_count="count",
                  )
                  .reset_index()
            )

        # Merge back so each row has its category's stats
        df = df.merge(cat_stats, on="Category", how="left")
        print(
            "Added category-level stats: cat_mean_vcvr, "
            "cat_median_vcvr, cat_count"
        )

    # === 3. DROP BAD COLUMNS (TOO MANY MISSING VALUES) =============
    # Columns with a high percentage of missing values are often not very useful.
    # You can tweak this threshold (0.4 = 40%).
    missing_ratio = df.isnull().mean()

    cols_to_drop = []
    for c in df.columns:
        # Don't drop target; don't drop RANK; don't drop RANK_missing
        if c in [TARGET_COL, "RANK", "RANK_missing"]:
            continue
        if missing_ratio[c] > 0.40:
            cols_to_drop.append(c)

    if cols_to_drop:
        print("Dropping columns with >40% missing values:")
        for c in cols_to_drop:
            print(f"  - {c} (missing {missing_ratio[c]:.1%})")

    df = df.drop(columns=cols_to_drop)

    # === 4. SEPARATE TARGET AND ID COLUMNS =========================
    target = df[TARGET_COL].astype(float)
    id_cols_present = [c for c in ID_COLS if c in df.columns]

    # Remove ID columns + target from feature matrix
    feature_df = df.drop(columns=id_cols_present + [TARGET_COL])

    # === 5. WORK ONLY WITH NUMERIC FEATURES FOR NOW ================
    # For v1, ignore non-numeric columns. Later you can add proper encoding if needed.
    num_cols = feature_df.select_dtypes(include=[np.number]).columns.tolist()
    feature_df = feature_df[num_cols]

    # === 6. IMPUTE (FILL) MISSING NUMERIC VALUES ===================
    # Strategy:
    #   - For counts/ratios/percent-like features → fill with 0
    #   - For other numeric features → fill with median
    #   - We skip special columns like RANK (already handled)

    imputation_info = {
        "zero_cols": [],         # columns we filled with 0
        "median_cols": {},       # columns we filled with their median
        "dropped_cols": cols_to_drop,
        "sentinel_cols": sentinel_cols,  # e.g. {"RANK": -1}
    }

    special_impute_cols = set(["RANK", "RANK_missing"])  # handled separately / no NAs

    for col in num_cols:
        if col in special_impute_cols:
            # RANK is already imputed; RANK_missing is 0/1 with no NAs.
            continue

        col_missing = feature_df[col].isnull().mean()
        if col_missing == 0:
            # nothing to do
            continue

        # Heuristic: treat columns with names that look like counts/ratios/percents
        # as "0 means none" when missing.
        col_upper = col.upper()
        if "COUNT" in col_upper or "RATIO" in col_upper or "PERCENT" in col_upper:
            feature_df[col] = feature_df[col].fillna(0)
            imputation_info["zero_cols"].append(col)
            print(f"Filled missing values in '{col}' with 0 (count/ratio-like).")
        else:
            median_val = feature_df[col].median()
            feature_df[col] = feature_df[col].fillna(median_val)
            imputation_info["median_cols"][col] = float(median_val)
            print(
                f"Filled missing values in '{col}' with median={median_val:.4f}."
            )

    # Final safety check: no NaNs should remain in features
    if feature_df.isnull().any().any():
        n_bad = feature_df.isnull().any(axis=1).sum()
        print(f"WARNING: {n_bad} rows still have NaNs after imputation.")

    X = feature_df
    y = target.loc[X.index]

    print(f"Final feature matrix shape: {X.shape}")
    print(f"Final target shape:        {y.shape}")

    # --- Build sample weights from Clicks (optional but recommended) ---
    # Default: no weights
# === 8. BUILD SAMPLE WEIGHTS: CLICKS + INTERNAL FLAG ===========
    sample_weight = None

    # Base weight from Clicks (if present)
    if "Clicks" in df.columns:
        clicks = df.loc[X.index, "Clicks"].astype(float)
        # Guard against zero / negative
        clicks = clicks.clip(lower=1)

        # sqrt of capped clicks: softer than linear, prevents whales dominating
        base_weight = np.sqrt(clicks.clip(upper=1000))
    else:
        base_weight = np.ones(len(X))
        print("Clicks column not found; using uniform base weights.")

    # Internal vs external multiplier
    if INTERNAL_FLAG_COL in df.columns:
        internal_flag = df.loc[X.index, INTERNAL_FLAG_COL].fillna(0)
        # Expecting 0/1; if it's True/False, this still works
        internal_flag = (internal_flag != 0).astype(int)

        internal_multiplier = np.where(internal_flag == 1, 2.0, 1.0)
        sample_weight = base_weight * internal_multiplier

        print(
            f"Applied internal page weight multiplier (x2) "
            f"using '{INTERNAL_FLAG_COL}' flag."
        )
    else:
        sample_weight = base_weight
        print(
            f"Internal flag column '{INTERNAL_FLAG_COL}' not found; "
            f"no internal vs external weighting applied."
        )

    return X, y, imputation_info, sample_weight


from sklearn.model_selection import train_test_split

def train_model(X, y, sample_weight: np.ndarray | None = None) -> XGBRegressor:
    if sample_weight is not None:
        X_train, X_val, y_train, y_val, w_train, w_val = train_test_split(
            X, y, sample_weight,
            test_size=0.2,
            random_state=42
        )
    else:
        X_train, X_val, y_train, y_val = train_test_split(
            X, y,
            test_size=0.2,
            random_state=42
        )
        w_train = None
        w_val = None

    model = XGBRegressor(
        n_estimators=1200,
        learning_rate=0.03,
        max_depth=8,
        subsample=0.8,
        colsample_bytree=0.8,
        objective="reg:squarederror",
        n_jobs=-1,
        tree_method="hist",
        early_stopping_rounds=50,
    )

    model.fit(
        X_train,
        y_train,
        sample_weight=w_train,   # <-- here’s where weights go
        eval_set=[(X_val, y_val)],
        verbose=50,
    )

    y_val_pred = model.predict(X_val)
    mae = mean_absolute_error(y_val, y_val_pred)
    r2 = r2_score(y_val, y_val_pred)

    print("Validation MAE:", mae)
    print("Validation R²:", r2)

    return model



def save_model(model: XGBRegressor, feature_columns, imputation_info, path: Path):
    """
    Save:
      - model
      - feature_columns (order matters for inference)
      - imputation_info (so inference can mimic training-time imputation)
    """
    payload = {
        "model": model,
        "feature_columns": list(feature_columns),
        "imputation_info": imputation_info,
    }
    joblib.dump(payload, path)
    print(f"Saved model + metadata to {path}")


def main():
    # 1. Load raw data
    df = load_data(DATA_PATH)

    # 2. Clean + handle missing values
    #    This is where:
    #      - rows with missing VCVR are dropped
    #      - columns with >40% missing are dropped
    #      - RANK gets special handling (sentinel + missing flag)
    #      - other numeric columns get 0/median imputation
    X, y, imputation_info, sample_weight = clean_and_impute(df)

    model = train_model(X, y, sample_weight=sample_weight)

    save_model(model, X.columns, imputation_info, MODEL_PATH)


if __name__ == "__main__":
    main()










# predict_vcvr.py

import pandas as pd
import numpy as np
from pathlib import Path
import joblib

MODEL_PATH = Path("vcvr_xgb_model.joblib")


def load_trained_model():
    """
    Load the trained model and metadata:
      - model
      - feature_columns: list of columns in the order expected by the model
      - imputation_info: how we filled missing values during training
    """
    payload = joblib.load(MODEL_PATH)
    model = payload["model"]
    feature_columns = payload["feature_columns"]
    imputation_info = payload.get("imputation_info", None)
    return model, feature_columns, imputation_info


def apply_basic_imputation_for_inference(df: pd.DataFrame, imputation_info) -> pd.DataFrame:
    """
    At inference we ideally have clean features already (your LP feature extractor
    should mirror the training engineering), but this function:
      - applies the same "fill with 0" for zero_cols
      - applies the same medians for median_cols
      - ensures no NaNs are left

    This helps when the extractor is imperfect or when some fields are occasionally missing.
    """

    df = df.copy()

    if imputation_info is None:
        # Fallback: just fill any remaining NaNs with 0
        # (you may want to be more strict and log/warn here)
        return df.fillna(0)

    # Fill training-time zero_cols with 0
    for col in imputation_info.get("zero_cols", []):
        if col in df.columns:
            df[col] = df[col].fillna(0)

    # Fill training-time median_cols with same median values
    for col, median_val in imputation_info.get("median_cols", {}).items():
        if col in df.columns:
            df[col] = df[col].fillna(median_val)

    # Any remaining NaNs after the above → default to 0
    df = df.fillna(0)

    return df


def predict_vcvr_from_features(features: pd.DataFrame) -> np.ndarray:
    """
    features: DataFrame with (ideally) the same columns used during training.
              Extra columns are ignored. Missing columns are added as 0.

    Returns:
      np.ndarray of predicted VCVR values.
    """
    model, feature_columns, imputation_info = load_trained_model()

    # Work only with numeric features for safety
    features_num = features.select_dtypes(include=[np.number]).copy()

    # Apply similar imputation logic as during training
    features_num = apply_basic_imputation_for_inference(features_num, imputation_info)

    # Reindex to match training feature order.
    # Any missing columns will be created and filled with 0.
    X = features_num.reindex(columns=feature_columns, fill_value=0.0)

    # Optional sanity check/logging
    missing_cols = [c for c in feature_columns if c not in features_num.columns]
    if missing_cols:
        print(f"WARNING: {len(missing_cols)} expected feature columns were missing at inference.")
        # In a production system you might log these somewhere.

    preds = model.predict(X)
    return preds


# Example usage with your existing CSV row (to smoke test prediction)
if __name__ == "__main__":
    df = pd.read_csv("/mnt/data/landing_page_features.csv")

    # Drop obvious non-feature columns if present
    for col in ["URL", "VCVR"]:
        if col in df.columns:
            df = df.drop(columns=[col])

    preds = predict_vcvr_from_features(df)

    # If you still have the URLs somewhere, you can map them;
    # here we just print index + prediction.
    for i, pred in enumerate(preds):
        print(f"Row {i} → predicted VCVR: {pred:.4f}")
