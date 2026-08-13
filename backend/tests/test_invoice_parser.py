from backend.app.invoice_parser import (
    _normalize_invoice_text,
    _parse_invoice_deterministically,
    parse_invoice_spreadsheet,
)


def parse_text(text: str):
    return _parse_invoice_deterministically([(1, text)])


def test_page_footer_cleanup_does_not_erase_order_code_digits():
    text = "9-86146 / 37 x 1\n2 / 8\n"
    normalized = _normalize_invoice_text(text)
    assert "9-86146 / 37" in normalized
    assert "2 / 8" not in normalized


def test_12livery_parses_both_store_prefixes_and_reconciles_totals():
    parsed = parse_text(
        """
        12Livery Facture : FCT-1 Date : 2026-07-29 13:52:10 Colis : 2
        1 7-159299 2026-07-28 2026-07-28 Livré Casablanca 150 DH 15 DH 135 DH
        2 9-84892 2026-07-28 2026-07-28 Livré Bouskoura 170 DH 25 DH 145 DH
        Total Brut 320 DH Frais 40 DH Autres frais 0 DH Total Net 280 DH
        """
    )
    assert parsed["company"] == "12Livery"
    assert [row["sendCode"] for row in parsed["rows"]] == ["7-159299", "9-84892"]
    assert parsed["totalBrut"] == 320
    assert parsed["totalFees"] == 40
    assert parsed["totalNet"] == 280


def test_tcpdf_variants_parse_ibex_pal_lionex_and_fast():
    fixtures = [
        (
            "IBEX Facture : FCT-I Date : 2026-08-03 23:22 Colis : 1 "
            "1 7-159993 1970-01-01 2026-08-03 Livré Agadir 16 DH 18 DH DH -2 DH "
            "Total Brut 16 DH Frais 18 DH Total Net -2 DH",
            "IBEX",
            16,
            18,
            -2,
        ),
        (
            "Pal Express Facture : FCT-P Date : 2026-08-07 11:14 Colis : 1 "
            "1 7-160475 SAFI Ms 2026-08-06 Livré 200 DH 25 DH 945536 DH 0655346724 "
            "Total Brut 200 DH Frais 25 DH Total Net 175 DH",
            "Pal Express",
            200,
            25,
            175,
        ),
        (
            "Lionex Facture : FCT-L Date : 2026-08-03 19:34 Colis : 1 "
            "1 9-84153 2026-07-25 2026-08-01 0607167161 Livré Marrakech 15 20 DH -5 DH DH "
            "Total Brut 15 DH Frais 20 DH Total Net -5 DH",
            "Lionex",
            15,
            20,
            -5,
        ),
        (
            "Fast Delivery Facture : FCT-F Date : 2026-08-08 12:00 Colis : 1 "
            "1 9-90001 2026-08-07 2026-08-08 Livré Casablanca 250 DH 25 DH 225 DH "
            "Total Brut 250 DH Frais 25 DH Total Net 225 DH",
            "Fast",
            250,
            25,
            225,
        ),
    ]
    for text, company, crbt, fees, total in fixtures:
        parsed = parse_text(text)
        assert parsed["company"] == company
        assert len(parsed["rows"]) == 1
        assert parsed["rows"][0]["crbt"] == crbt
        assert parsed["rows"][0]["fees"] == fees
        assert parsed["rows"][0]["total"] == total


def test_mpdf_yfd_and_oscario_rows_use_merchant_codes_and_reverse_totals():
    yfd = parse_text(
        """
        Nombre de colis: 1 Date: 05/08/2026 Facture client Nº: FC-1
        YFD-01082026-5637721 pink / 37 / black 3 0620545636 Kenitra Livré 170 DH 25 DH 9-86146 / 37 x 1
        170 Total Brut DH 25 Frais TTC DH 145 Total Net DH
        """
    )
    assert yfd["company"] == "YFD"
    assert yfd["rows"][0]["sendCode"] == "9-86146"
    assert yfd["rows"][0]["yfdCode"] == "YFD-01082026-5637721"
    assert (yfd["totalBrut"], yfd["totalFees"], yfd["totalNet"]) == (170, 25, 145)

    oscario = parse_text(
        """
        Nombre de colis: 1 Date: 07/08/2026 Facture client Nº: FC-2
        OSC-05082026-4652148 1 0662791584 Ksar el kebir blue / 38 x 1 Livré 240 DH 25 DH 9-87620
        240 Total Brut DH Frais TTC 25 DH 215 Total Net DH
        """
    )
    assert oscario["company"] == "Oscario"
    assert oscario["rows"][0]["sendCode"] == "9-87620"
    assert oscario["rows"][0]["total"] == 215


def test_refused_rows_use_zero_crbt_and_negative_fee_net():
    parsed = parse_text(
        """
        Lionex Facture : FCT-R Date : 2026-08-03 19:34 Colis : 1
        1 7-159659 2026-07-31 0722068557 Refusé Chichaoua 370 10 DH -10 DH DH
        Total Brut 370 DH Frais 10 DH Total Net -10 DH
        """
    )
    row = parsed["rows"][0]
    assert row["crbt"] == 0
    assert row["fees"] == 10
    assert row["total"] == -10


def test_livre24_html_xls_export_is_parsed_without_an_llm():
    raw = """
    <html><body><table>
      <tr><th>Nº</th><th>Code</th><th>ID Intern</th><th>Telephone</th><th>Ville</th><th>Etat</th><th>CRBT</th><th>Frais</th></tr>
      <tr><td>1</td><td>L24-29072026-9796334</td><td>9-85226</td><td>0664076076</td><td>Berkane</td><td>Livré</td><td>170</td><td>25</td></tr>
      <tr><td></td><td></td><td></td><td></td><td></td><td>Total Brut</td><td>170</td><td></td></tr>
      <tr><td></td><td></td><td></td><td></td><td></td><td>Frais TTC</td><td>25</td><td></td></tr>
      <tr><td></td><td></td><td></td><td></td><td></td><td>Charges supplementaires</td><td>5</td><td></td></tr>
      <tr><td></td><td></td><td></td><td></td><td></td><td>Total Net</td><td>140</td><td></td></tr>
    </table></body></html>
    """.encode("utf-8")
    parsed = parse_invoice_spreadsheet(raw, "FC-30072026-55423.xls")
    assert parsed["company"] == "Livre24"
    assert parsed["invoiceDate"] == "30/07/2026"
    assert parsed["rows"][0]["sendCode"] == "9-85226"
    assert parsed["rows"][0]["phone"] == "0664076076"
    assert (parsed["totalBrut"], parsed["totalFees"], parsed["totalAdditionalFees"], parsed["totalNet"]) == (170, 25, 5, 140)


def test_casa_run_speed_parses_client_rows_and_totals_without_an_llm():
    parsed = parse_text(
        """
        Run Speed delivery Client : irrakids Facture : FCT-100826-030940-30-319
        Nom de client : chafik Date : 2026-08-10 23:18 Colis : 2
        1 9-88547 2026-08-08 2026-08-08 0723130318 Livré Casablanca 188 15 DH 173 DH
        2 7-160758 2026-08-07 2026-08-07 0645039401 Livré Casablanca 1 DH 15 DH -14 DH
        Total Brut 189 DH Frais 30 DH Autres frais 0 DH Total Net 159 DH
        """
    )
    assert parsed["company"] == "Casa"
    assert parsed["merchant"] == "irrakids"
    assert [row["sendCode"] for row in parsed["rows"]] == ["9-88547", "7-160758"]
    assert [row["crbt"] for row in parsed["rows"]] == [188, 1]
    assert (parsed["totalBrut"], parsed["totalFees"], parsed["totalNet"]) == (189, 30, 159)
