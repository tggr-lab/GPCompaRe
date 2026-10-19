"""Site generator for GPCompaReports v2 — Primer + teal/orange design system.

Self-contained v2 pipeline. The v1 site lives in ../GPCompReports/ and is
unchanged by this build; the two projects share only the upstream RRCS batch
data (../The_batch_RRCS_analyzer/batch_analysis_full/).
"""

import shutil
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from ..analysis.data_loader import GPCRDataStore
from ..analysis.cross_gpcr_analysis import run_cross_gpcr_analysis
from ..analysis.tm_domain_analysis import run_tm_domain_analysis
from ..analysis.cfr_analysis import run_cfr_analysis
from ..analysis.manuscript_stats import load_manuscript_stats
from ..analysis.variant_correlation import run_variant_analysis
from .page_generators.landing_page import generate_landing_page
from .page_generators.gpcr_index import generate_gpcr_index
from .page_generators.gpcr_report_page import generate_all_reports
from .page_generators.statistics_page import generate_statistics_page
from .page_generators.contact_page import generate_contact_page
from .page_generators.downloads_page import generate_downloads_page
from .page_generators.info_pages import generate_glossary_page, generate_privacy_page
from .seo import SITE_URL, write_robots, write_sitemap, write_gene_redirects


def select_gpcr_ids(all_ids, limit=None, only=None):
    """Pick which receptors get report pages.

    `only` is an explicit ordered list of filesystem ids and wins over `limit`.
    `limit` takes the first N in the order the store discovered them.
    """
    if only:
        known = set(all_ids)
        missing = [g for g in only if g not in known]
        if missing:
            raise ValueError(
                "unknown gpcr id(s): %s" % ", ".join(sorted(missing)))
        return list(only)
    if limit:
        return list(all_ids[:limit])
    return list(all_ids)


class SiteGenerator:
    """Orchestrates the v2 pipeline: load -> analyze -> generate pages."""

    def __init__(self, batch_dir=None, metadata_csv=None, output_dir=None, limit=None, only=None):
        self.base_dir = Path(__file__).resolve().parent.parent
        self.output_dir = Path(output_dir) if output_dir else self.base_dir / 'output'
        self.template_dir = self.base_dir / 'templates'
        self.static_dir = self.base_dir / 'static'
        self.limit = limit
        self.only = only

        self.store = GPCRDataStore(batch_dir=batch_dir, metadata_csv=metadata_csv)
        self.analysis_results = {}

    def run(self):
        print("=" * 60)
        print("GPCompaReports v2 — Site Generator")
        print("=" * 60)

        print("\n[1/5] Loading data...")
        self.store.load_all()

        print("\n[2/5] Running cross-GPCR analysis...")
        self.analysis_results['cross_gpcr'] = run_cross_gpcr_analysis(self.store)

        print("\n[3/5] Running TM domain, CFR, and variant analysis...")
        self.analysis_results['tm_domain'] = run_tm_domain_analysis(self.store)
        # Feeds the report pages' snake-plot Core Functional colouring. Those
        # 283 pages are frozen, so this stays computed from the site's own
        # per-receptor annotation and must not be repointed.
        self.analysis_results['cfr'] = run_cfr_analysis(self.store)

        # Feeds the statistics page only: cross-receptor recurrence as
        # submitted with the manuscript, computed there on the full GPCRdb
        # residue maps. See analysis/manuscript_stats.py.
        manuscript = load_manuscript_stats()
        self.analysis_results['manuscript'] = manuscript

        # The statistics page consumes only the conservation-versus-magnitude
        # scatter from this, which does not depend on the CFR list. The
        # enrichment figures come from the manuscript block above, and no
        # per-variant table is rendered, so this keeps the site's own list.
        self.analysis_results['variant'] = run_variant_analysis(
            self.store, self.analysis_results['cfr'].get('cfr_table'))

        print("\n[4/5] Preparing output directory...")
        self._prepare_output()

        print("\n[5/5] Generating website pages...")
        env = Environment(loader=FileSystemLoader(str(self.template_dir)))
        env.globals['site_url'] = SITE_URL

        print("  Landing page...")
        generate_landing_page(env, self.store, self.output_dir)

        print("  GPCR browser...")
        generate_gpcr_index(env, self.store, self.output_dir)

        print("  Statistics page...")
        generate_statistics_page(env, self.store, self.analysis_results, self.output_dir)

        print("  Contact page...")
        generate_contact_page(env, self.store, self.output_dir)

        print("  Downloads page...")
        generate_downloads_page(env, self.store, self.output_dir)

        print("  Glossary and privacy pages...")
        generate_glossary_page(env, self.store, self.output_dir)
        generate_privacy_page(env, self.store, self.output_dir)

        selected = select_gpcr_ids(self.store.gpcr_ids, self.limit, self.only)
        print(f"  Individual reports ({len(selected)} pages)...")
        generate_all_reports(env, self.store, self.output_dir,
                             analysis_results=self.analysis_results,
                             only=selected)

        print("  robots.txt, sitemap.xml, gene-symbol redirects...")
        write_robots(self.output_dir)
        n_urls = write_sitemap(self.output_dir, selected)
        stubs = write_gene_redirects(self.output_dir, self.store, selected)
        print(f"  sitemap.xml: {n_urls} URLs; {len(stubs)} gene-symbol redirects")

        print("\n" + "=" * 60)
        print("Site generation complete!")
        print(f"Open: {self.output_dir / 'index.html'}")
        print("=" * 60)

    def _prepare_output(self):
        for subdir in ['reports', 'browse', 'data', 'static/css', 'static/js', 'static/img']:
            (self.output_dir / subdir).mkdir(parents=True, exist_ok=True)
        for src in self.static_dir.rglob('*'):
            if src.is_file():
                rel = src.relative_to(self.static_dir)
                dst = self.output_dir / 'static' / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        print(f"  Output directory: {self.output_dir}")
