"""Load all batch RRCS analysis data into memory for cross-GPCR analysis."""

import ast
import os
from pathlib import Path

import pandas as pd


# Default batch results path
BATCH_DIR = Path(__file__).resolve().parent.parent.parent / (
    "The_batch_RRCS_analyzer/batch_analysis_full/batch_analysis_20260202_151051"
)
METADATA_CSV = Path(__file__).resolve().parent.parent.parent / "class_A_all.csv"


class GPCRDataStore:
    """Central data store holding all loaded GPCR data."""

    def __init__(self, batch_dir=None, metadata_csv=None):
        self.batch_dir = Path(batch_dir) if batch_dir else BATCH_DIR
        self.metadata_csv = Path(metadata_csv) if metadata_csv else METADATA_CSV
        self.csv_dir = self.batch_dir / "csv_data"
        self.variant_dir = self.batch_dir / "variants"
        self.summary_csv = self.batch_dir / "summary" / "processing_results.csv"

        # Data containers
        self.metadata = None          # DataFrame: uniprot_name, gene_name, family, ligand_type
        self.processing_summary = None  # DataFrame from processing_results.csv
        self.gpcr_ids = []            # list of filesystem gpcr ids (e.g. '5ht1a_human')
        self.delta_data = {}          # gpcr_id -> DataFrame
        self.annotation_data = {}     # gpcr_id -> DataFrame
        self.significant_data = {}    # gpcr_id -> DataFrame
        self.variant_data = {}        # gpcr_id -> DataFrame
        self.gpcr_info = {}           # gpcr_id -> dict with metadata + summary stats
        self.name_map = {}            # filesystem id -> uniprot name (uppercase)
        # The report pages' variant and annotation layer (analysis/pack_layer.py), read from the
        # Studio packs on first use. variant_data and annotation_data above stay the batch run's:
        # the family-wide analyses (CFR ranking, statistics page, paper numbers) read those.
        self.report_layer = None
        self._report_layer_tried = False
        self.report_variant_source = 'gnomad_batch'  # data_versions.json key of what report_variants() returns

    def load_all(self):
        """Load all data sources."""
        print("Loading GPCR metadata...")
        self._load_metadata()
        print("Loading processing summary...")
        self._load_processing_summary()
        print("Building name map...")
        self._build_name_map()
        print(f"Loading CSV data for {len(self.gpcr_ids)} GPCRs...")
        self._load_csv_data()
        print(f"Loading variant data...")
        self._load_variant_data()
        print("Building GPCR info index...")
        self._build_gpcr_info()
        print(f"Data loading complete: {len(self.gpcr_ids)} GPCRs loaded")
        return self

    def _load_metadata(self):
        """Load class_A_all.csv with multiline header handling."""
        raw = self.metadata_csv.read_text()
        lines = raw.strip().split('\n')
        # The header spans lines 1-3 due to quoted multiline fields
        # Reconstruct: skip multiline header, use clean column names
        data_lines = []
        i = 0
        in_quotes = False
        header_end = 0
        for idx, line in enumerate(lines):
            if idx == 0:
                in_quotes = line.count('"') % 2 == 1
                if not in_quotes:
                    header_end = idx
                continue
            if in_quotes:
                in_quotes = line.count('"') % 2 == 0
                if not in_quotes:
                    header_end = idx
                continue
            data_lines.append(line)

        self.metadata = pd.DataFrame(
            [self._parse_csv_line(l) for l in data_lines if l.strip()],
            columns=['uniprot_name', 'gene_name', 'receptor_family', 'ligand_type', 'class']
        )

    @staticmethod
    def _parse_csv_line(line):
        """Parse a CSV line handling quoted fields with commas."""
        fields = []
        current = ''
        in_quotes = False
        for ch in line:
            if ch == '"':
                in_quotes = not in_quotes
            elif ch == ',' and not in_quotes:
                fields.append(current.strip())
                current = ''
            else:
                current += ch
        fields.append(current.strip())
        return fields

    def _load_processing_summary(self):
        """Load processing_results.csv and parse summary dicts."""
        self.processing_summary = pd.read_csv(self.summary_csv)
        # Parse the summary dict strings
        summaries = []
        for _, row in self.processing_summary.iterrows():
            try:
                s = ast.literal_eval(row['summary'])
            except (ValueError, SyntaxError):
                s = {}
            summaries.append(s)
        self.processing_summary['parsed_summary'] = summaries

    def _build_name_map(self):
        """Map filesystem IDs to metadata entries.

        Filesystem: '5ht1a_human' -> metadata: '5HT1A'
        Mapping: lowercase(uniprot_name) + '_human' == filesystem_id
        """
        # Discover all GPCRs with delta CSV files
        delta_files = sorted(self.csv_dir.glob("*_rrcs_delta.csv"))
        self.gpcr_ids = [f.stem.replace("_rrcs_delta", "") for f in delta_files]

        # Build forward and reverse maps
        meta_lookup = {}
        for _, row in self.metadata.iterrows():
            key = row['uniprot_name'].lower() + '_human'
            meta_lookup[key] = row['uniprot_name']

        for gid in self.gpcr_ids:
            if gid in meta_lookup:
                self.name_map[gid] = meta_lookup[gid]
            else:
                # Fallback: try matching via processing_summary uniprot_id
                self.name_map[gid] = gid.replace('_human', '').upper()

    def _load_csv_data(self):
        """Load delta, annotation, and significant_changes CSVs."""
        for gid in self.gpcr_ids:
            delta_path = self.csv_dir / f"{gid}_rrcs_delta.csv"
            annot_path = self.csv_dir / f"{gid}_annotations.csv"
            sig_path = self.csv_dir / f"{gid}_significant_changes.csv"

            if delta_path.exists():
                self.delta_data[gid] = pd.read_csv(delta_path)
            if annot_path.exists():
                self.annotation_data[gid] = pd.read_csv(annot_path)
            if sig_path.exists():
                self.significant_data[gid] = pd.read_csv(sig_path)

    def _load_variant_data(self):
        """Load variant CSVs."""
        for gid in self.gpcr_ids:
            var_path = self.variant_dir / f"{gid}_variants.csv"
            if var_path.exists():
                self.variant_data[gid] = pd.read_csv(var_path)

    def _build_gpcr_info(self):
        """Build per-GPCR info dicts combining all data sources."""
        meta_dict = {}
        for _, row in self.metadata.iterrows():
            meta_dict[row['uniprot_name']] = {
                'gene_name': row['gene_name'],
                'receptor_family': row['receptor_family'],
                'ligand_type': row['ligand_type'],
            }

        # Parse processing summary into lookup
        proc_dict = {}
        for _, row in self.processing_summary.iterrows():
            proc_dict[row['gpcr']] = row['parsed_summary']

        for gid in self.gpcr_ids:
            uname = self.name_map.get(gid, gid.replace('_human', '').upper())
            meta = meta_dict.get(uname, {})
            proc = proc_dict.get(gid, {})

            delta_df = self.delta_data.get(gid, pd.DataFrame())
            sig_df = self.significant_data.get(gid, pd.DataFrame())
            var_df = self.variant_data.get(gid, pd.DataFrame())

            info = {
                'gpcr_id': gid,
                'uniprot_name': uname,
                'gene_name': meta.get('gene_name', ''),
                'receptor_family': meta.get('receptor_family', ''),
                'ligand_type': meta.get('ligand_type', ''),
                'uniprot_id': proc.get('uniprot_id', ''),
                'total_contacts': len(delta_df),
                'significant_changes': len(sig_df),
                'variants_found': len(var_df),
                'tm_domains_found': proc.get('tm_domains_found', 0),
                'sum_abs_delta': float(delta_df['abs_delta'].sum()) if len(delta_df) > 0 else 0.0,
                'mean_abs_delta': float(delta_df['abs_delta'].mean()) if len(delta_df) > 0 else 0.0,
                'max_abs_delta': float(delta_df['abs_delta'].max()) if len(delta_df) > 0 else 0.0,
            }
            self.gpcr_info[gid] = info

    # ------------------------------------------------------------ report layer (Studio packs)

    def load_report_layer(self, folder=None, required=False):
        """Read the report layer from the Studio packs (pack_layer.ReportLayer) and point the browse
        counts (gpcr_info['variants_found']) at it; the batch count is kept as 'variants_found_batch'.

        Without packs the reports keep the batch layer and say so through report_variant_source, unless
        `required`, which raises instead."""
        from .pack_layer import ReportLayer
        self._report_layer_tried = True
        try:
            self.report_layer = ReportLayer(self, folder)
        except FileNotFoundError as exc:
            if required:
                raise
            print('WARNING: %s; the report variant tables use the batch layer (gnomAD v4.1.0)' % exc)
            self.report_layer = None
            self.report_variant_source = 'gnomad_batch'
            return None
        self.report_variant_source = 'gnomad'
        from .pack_layer import WRONG_RECEPTOR_ANNOTATION
        for gid, info in self.gpcr_info.items():
            info.setdefault('variants_found_batch', info['variants_found'])
            info['variants_found'] = len(self.report_layer.variants.get(gid, ()))
            # The batch took GPR31's, GPR42's and CXCR1's accession for these three (substring match);
            # the report header, its UniProt link and the protein name use the receptor's own.
            if gid in WRONG_RECEPTOR_ANNOTATION and self.report_layer.uniprot.get(gid):
                info.setdefault('uniprot_id_batch', info['uniprot_id'])
                info['uniprot_id'] = self.report_layer.uniprot[gid]
        return self.report_layer

    def _layer(self):
        if self.report_layer is None and not self._report_layer_tried:
            self.load_report_layer()
        return self.report_layer

    def report_variants(self, gpcr_id):
        """The rows the report's variant table lists (batch CSV columns)."""
        layer = self._layer()
        if layer is not None:
            return layer.variants.get(gpcr_id, pd.DataFrame())
        return self.variant_data.get(gpcr_id, pd.DataFrame())

    def get_report_annotation_map(self, gpcr_id):
        """get_annotation_map for the report pages: the pack's numbering for the three receptors whose
        batch annotation belongs to another receptor, the batch annotation (identical to the pack at
        every row) for the rest."""
        layer = self._layer()
        if layer is not None and gpcr_id in layer.annotation:
            return _annotation_map(layer.annotation[gpcr_id])
        return self.get_annotation_map(gpcr_id)

    def report_variants_note(self, gpcr_id):
        """pack_layer.no_variants_reason for a receptor whose report variant table is empty (the line the
        report shows in its place); None when the table has rows, and without packs."""
        layer = self._layer()
        return None if layer is None else layer.no_variants.get(gpcr_id)

    def report_hgvs_numbering(self, gpcr_id):
        """pack_layer.hgvs_numbering for the report table (None for most receptors and without packs)."""
        layer = self._layer()
        return None if layer is None else layer.hgvs_numbering(gpcr_id)

    def report_conservation(self, gpcr_id):
        """{position: conservation} from the packs, or None without the report layer."""
        layer = self._layer()
        return None if layer is None else layer.conservation.get(gpcr_id, {})

    def report_am_mean(self, gpcr_id):
        """{position: mean AlphaMissense score} from the packs, or None without the report layer."""
        layer = self._layer()
        return None if layer is None else layer.am_mean.get(gpcr_id, {})

    def get_all_info_df(self):
        """Return a DataFrame of all GPCR info for ranking/comparison."""
        return pd.DataFrame(list(self.gpcr_info.values()))

    def get_annotation_map(self, gpcr_id):
        """Return position -> annotation dict for a GPCR."""
        return _annotation_map(self.annotation_data.get(gpcr_id, pd.DataFrame()))


def _annotation_map(df):
    """position -> annotation dict from an annotations frame (batch CSV columns)."""
    if df.empty:
        return {}
    result = {}
    for _, row in df.iterrows():
        pos = int(row['position'])
        result[pos] = {
            'amino_acid': _safe_str(row.get('amino_acid', '')),
            'generic_number': _safe_str(row.get('generic_number', '')),
            'display_number': _safe_str(row.get('display_number', '')),
            'protein_segment': _safe_str(row.get('protein_segment', '')),
        }
    return result


def _safe_str(val):
    """Convert value to string, returning '' for NaN/None."""
    if pd.isna(val):
        return ''
    return str(val).strip()
