import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import update_data as u

FX = Path(__file__).parent / "fixtures"

class T(unittest.TestCase):
    def test_links(self):
        links = u.find_epc_csv_links((FX / "epc_page.html").read_text(), "https://www.europeanpaymentscouncil.eu/page")
        self.assertEqual(links["sdd_core"], "https://www.europeanpaymentscouncil.eu/export/register?id=17&_format=csv")
        self.assertEqual(links["sdd_b2b"], "https://www.europeanpaymentscouncil.eu/export/register?id=18&_format=csv")

    def test_links_by_url(self):
        html = '<a href="/f/sdd_b2b.csv">CSV</a><a href="/f/sdd_core.csv">CSV</a><a href="/f/sct.csv">CSV</a>'
        links = u.find_epc_csv_links(html, "https://x.eu/")
        self.assertEqual(links, {"sdd_core": "https://x.eu/f/sdd_core.csv", "sdd_b2b": "https://x.eu/f/sdd_b2b.csv"})

    def test_links_missing(self):
        with self.assertRaises(u.SourceError):
            u.find_epc_csv_links('<a href="/f/sct.csv">CSV</a>', "https://x.eu/")

    def test_parse_csv(self):
        rows = u.parse_epc_csv((FX / "sdd_core.csv").read_bytes())
        d = {r[0]: r for r in rows}
        self.assertEqual(d["DEUTDEFFXXX"], ["DEUTDEFFXXX", "Deutsche Bank AG", "DE"])
        self.assertEqual(d["SOGEFRPPXXX"][1], "Société Générale")

    def test_parse_html_rejected(self):
        with self.assertRaises(u.SourceError):
            u.parse_epc_csv(b"<!DOCTYPE html><html>Just a moment...</html>")

    def test_parse_comma_no_country(self):
        rows = u.parse_epc_csv(b'"BIC","Name"\n"COBADEFFXXX","Commerzbank"\n')
        self.assertEqual(rows, [["COBADEFFXXX", "Commerzbank", "DE"]])

if __name__ == "__main__":
    unittest.main()
