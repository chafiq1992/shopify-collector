import asyncio

from backend.app import invoice_parser as parser


def parse(text):
    return asyncio.run(parser.parse_invoice_from_pages([(1, text)]))


def test_large_twelve_invoice_keeps_bare_suffixed_and_short_references(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    codes = ["90164", "90373i"] + [f"9-{90000+i}" for i in range(108)]
    rows = [f"{i} {code} 2026-08-17 2026-08-18 Livré Casablanca 200 DH 25 DH 175 DH"
            for i, code in enumerate(codes, 1)]
    pages = [(i+1, "\n".join(rows[start:start+25])) for i, start in enumerate(range(0, 110, 25))]
    pages[0] = (1, "12Livery Colis : 110\n" + pages[0][1])
    pages[-1] = (len(pages), pages[-1][1] + "\nTotal Brut 22000 DH Frais 2750 DH Autres frais 0 DH Total Net 19250 DH")
    result = asyncio.run(parser.parse_invoice_from_pages(pages))
    assert result["validation"]["complete"] is True
    assert [r["sendCode"] for r in result["rows"]] == codes
    assert result["rows"][1]["orderNumber"] == "90373"


def test_casa_bare_reference_and_external_merchant_reconcile_with_wrapped_cells():
    result = parse("""Run Speed delivery Colis: 3
    1 7-162127 2026-08-20 2026-08-20 0709462012 Livré Errahma 250 23 DH 227 DH
    Ville DH
    2 17-136 2026-08-19 2026-08-20 0665616494 Livré Casablanc 300 23 DH 277 DH
    a DH
    3 91224 2026-08-20 2026-08-21 0666715673 Livré Berrchid 270 25 DH 245 DH
    DH
    Total Brut 820 DH Frais 71 DH Autres frais 0 DH Total Net 749 DH""")
    assert result["validation"]["complete"] is True
    assert [r["sendCode"] for r in result["rows"]] == ["7-162127", "17-136", "91224"]
    assert [r["city"] for r in result["rows"]] == ["Errahma Ville", "Casablanca", "Berrchid"]
    assert result["rows"][2]["total"] == 245


def test_livre24_all_pages_columns_duplicate_orders_and_wrapped_totals():
    rows = [f"{'17-125' if i == 43 else '7-'+str(160000+i%60)}\n"
            f"{i} 0600000000 Al Hoceima 22/08/2026 Livré 200 DH 25 DH\nL24-22082026-{1000000+i}"
            for i in range(1,69)]
    pages = [(1, "Nombre de colis: 68 Date: 22/08/2026 Facture client Nº: FC-22082026-TEST\n" + "\n".join(rows[:30])),
             (2, "\n".join(rows[30:60])), (3, "\n".join(rows[60:]) +
              "\n13600\nTotal Brut\nDH\n1700\nFrais TTC\nDH\nCharges\n200 DH\nsupplémentaires\n11700\nTotal Net\nDH")]
    result = asyncio.run(parser.parse_invoice_from_pages(pages))
    assert result["validation"]["complete"] is True
    assert len(result["rows"]) == 68  # repeated orders are separate shipments
    assert result["rows"][42]["orderNumber"] == "125"
    for row in result["rows"]:
        assert row["city"] == "Al Hoceima"
        assert row["deliveryDate"] == "22/08/2026"
        assert row["carrierCode"].startswith("L24-")
        assert row["phone"] == "0600000000"
        assert (row["crbt"], row["fees"], row["total"]) == (200, 25, 175)


def test_glog_fee_columns_and_signed_extras():
    result = parse("""Sté GLOG SOLUTIONS sarl 09-09-2026 Client Facture N° : FV00001-2026
        Example Sarl  Example Nbr des Commandes : 2
        Référence La Ville Montant Tarif Refusé Retour Dépenses Reste
        7-123456 MEKNES 270,00 15,00 2,00 3,00 4,00 246,00 Livrée - 08-09-2026 13:18
        17-125 Ras Lma -FES- 250,00 23,00 0,00 0,00 0,00 227,00 Livrée - 08-09-2026 14:18
        Totaux 520,00 38,00 2,00 3,00 4,00 473,00
        Total Commandes Reste Commandes Extras Total 520,00 MAD 473,00 MAD -10,00 MAD 463,00 MAD""")
    assert result["validation"]["complete"] is True
    assert result["invoiceNumber"] == "FV00001-2026"
    row = result["rows"][0]
    assert (row["tariff"], row["refusalFees"], row["returnFees"], row["expenses"], row["fees"], row["total"]) == (15, 2, 3, 4, 24, 246)
    assert result["totalAdditionalFees"] == 10


def test_missing_data_blank_pages_and_totals_are_never_verified():
    result = parse("12Livery Colis: 2 1 7-123456 2026-08-17 Livré Casablanca 200 DH 25 DH 175 DH")
    assert not result["validation"]["complete"]
    assert result["validation"]["expectedRows"] == 2
    parser.validate_invoice(result, [(1, ""), (2, "7-123456 9-99999")])
    assert any("No readable text" in w for w in result["validation"]["warnings"])
    assert any("references" in w for w in result["validation"]["warnings"])


def test_stub_rows_and_chunk_errors_are_visible_for_every_store_prefix(monkeypatch):
    async def fake_llm(*args, **kwargs):
        return {"rows": [], "error": "Chunk timed out"}
    monkeypatch.setattr(parser, "_call_llm_for_chunk", fake_llm)
    result = asyncio.run(parser.parse_invoice_from_pages([(1, "7-123456 9-654321 17-125")], api_key="test"))
    assert {r["sendCode"] for r in result["rows"]} == {"7-123456", "9-654321", "17-125"}
    assert result["validation"]["incompleteRows"] == 3
    assert "Chunk timed out" in result["validation"]["warnings"]
    assert not result["validation"]["complete"]


def test_dense_page_chunks_are_bounded_and_lose_no_lines():
    lines = [f"7-{100000+i} Livré Casablanca 200 DH 25 DH" for i in range(1000)]
    chunks = parser.chunk_pages([(1, "\n".join(lines))])
    assert len(chunks) > 2
    assert all(len(chunk) <= 10000 for chunk in chunks)
    assert "\n".join(chunks).splitlines()[1:] == lines


def test_order_numbers_do_not_absorb_suffix_digits_or_date_fragments():
    assert parser._extract_order_number("7-123456_RMB2") == "123456"
    assert parser._extract_order_number("17-125") == "125"
    assert not parser._MERCHANT_CODE_RE.findall("2026-08-18 L24-18082026-1234567 FV06890-2026")
    assert parser._safe_float("1\u202f234,56") == 1234.56
    assert parser._safe_float("Infinity") is None


def test_pdf_extraction_retains_empty_page_for_validation():
    import fitz
    with fitz.open() as doc:
        doc.new_page().insert_text((50, 50), "12Livery")
        doc.new_page()
        pages = parser.extract_pages_text(doc.tobytes())
    assert pages == [(1, "12Livery"), (2, "")]


def test_lionex_bare_and_carrier_references_wrapped_cod_and_advance():
    result = parse("""Lionex Colis: 4
    1 155878 2026-08-12 2026-08-12 0645811236 Livré Sidi Abdellah Ghiat 200 DH 33 DH 167 DH
    2 7-159733 2026-07-31 0624138346 Refusé Boujaad 150 DH 10 DH -10 DH
    3 LIONX8TW605 1970-01-01 2026-08-18 0600000000 Livré Oujda 1898
    7 DH 0 DH 18987 DH
    4 9-90386 2026-08-15 2026-08-17 +212688888 805 Livré Imintanou te 405 DH 25 DH 380 DH
    Total Brut 19592 DH Frais 68 DH Autres frais 20000 DH Total Net -476 DH""")
    assert result["validation"]["complete"]
    assert len(result["rows"]) == 4
    bare, refused, carrier, delivered = result["rows"]
    assert bare["sendCode"] == "155878"
    assert bare["city"] == "Sidi Abdellah Ghiat"
    assert refused["crbt"] == 0 and refused["total"] == -10
    assert refused["deliveryDate"] is None
    assert carrier["sendCode"] == "LIONX8TW605" and carrier["orderNumber"] == ""
    assert (carrier["crbt"], carrier["fees"], carrier["total"]) == (18987, 0, 18987)
    assert delivered["phone"] == "+212688888805"
    assert delivered["city"] == "Imintanoute"


def test_lionex_native_pdf_cell_order_joins_wrapped_cod():
    import fitz
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((30, 30), "Lionex Colis: 1")
        # Insert in native cell order, with wrapped digits below adjacent money.
        for x, y, text in [(30, 100, "1"), (55, 100, "LIONX8TW605"),
            (160, 100, "1970-01-01"), (240, 100, "2026-08-18"), (320, 100, "0600000000"),
            (390, 100, "Livré"), (390, 115, "Oujda"), (445, 100, "1898"),
            (445, 112, "7 DH"), (480, 100, "0 DH"), (520, 100, "18987 DH")]:
            page.insert_text((x, y), text, fontsize=8)
        page.insert_text((30, 200), "Total Brut 18987 DH Frais 0 DH Total Net 18987 DH")
        pages = parser.extract_pages_text(doc.tobytes())
    result = asyncio.run(parser.parse_invoice_from_pages(pages))
    assert result["validation"]["complete"]
    assert result["rows"][0]["crbt"] == 18987


def test_lionex_repeated_reference_keeps_both_shipments_and_bad_net_is_blocked():
    result = parse("""Lionex Colis: 2
    1 7-123456 2026-08-12 2026-08-12 Livré Marrakech 200 DH 20 DH 180 DH
    2 7-123456 2026-08-13 2026-08-13 Livré Marrakech 300 DH 20 DH 270 DH
    Total Brut 500 DH Frais 40 DH Total Net 450 DH""")
    assert len(result["rows"]) == 2
    assert not result["validation"]["complete"]
    assert result["rows"][1]["extractionIssues"] == ["Row amounts do not reconcile"]


def test_yfd_product_size_range_is_not_mistaken_for_a_merchant_code():
    # The printed row number runs into the "12-18 months" size of the product
    # column, which reads exactly like a merchant reference. Picking it loses the
    # real order and leaves a stub row that blocks the whole invoice.
    result = parse("\n".join([
        "Client: 5716-irrakids",
        "Nombre de colis: 2",
        "Date: 28/08/2026",
        "Facture client Nº:",
        "FC-28082026-00001",
        "Nº         Code          Téléphone        Ville         Produit      Etat        CRBT            Frais",
        "YFD-25082026-4711042",
        "1                    0624694354      Rabat       blue / 27 x 1     Livré        230 DH        20 DH        7-163181",
        "YFD-25082026-1259525                    brown / 12-1820              0634655632     El menzeh          Livré     385 DH      25 DH",
        "7-162096                            months / Khaki /",
        "36 x 1",
        "Total Brut 615 DH Frais TTC 45 DH Total Net 570 DH",
    ]))
    assert [r["sendCode"] for r in result["rows"]] == ["7-163181", "7-162096"]
    assert [r["orderNumber"] for r in result["rows"]] == ["163181", "162096"]
    assert result["validation"]["warnings"] == []
    assert result["validation"]["complete"] is True


def test_yfd_city_comes_from_the_printed_column_and_never_blocks_payment():
    # YFD prints the city before the status, interleaved with the product, so the
    # column gaps are the only reliable source — and a city that wrapped out of
    # its cell must still leave a reconciled row payable.
    result = parse("\n".join([
        "Client: 5716-irrakids",
        "Nombre de colis: 2",
        "Facture client Nº:",
        "FC-28082026-00002",
        "YFD-24082026-7481448",
        "1                  0696446192       Allal tazi      black / 42 x 1    Livré      250 DH     30 DH      9-89066",
        "YFD-26082026-4900614           Sala al      jeans / 8 years / 2          0708260027            Livré     249 DH     25 DH",
        "7-163382                       jadida       black / 30 x 1",
        "Total Brut 499 DH Frais TTC 55 DH Total Net 444 DH",
    ]))
    assert [r["city"] for r in result["rows"]] == ["Allal tazi", None]
    assert [r["extractionComplete"] for r in result["rows"]] == [True, True]
    assert result["validation"]["complete"] is True


def test_glog_bare_references_are_kept_and_money_cells_are_not_mistaken_for_them():
    # G-Log prints some references without their store prefix. Dropping them
    # loses real orders and silently breaks every printed total.
    result = parse("""Sté GLOG SOLUTIONS sarl 17-08-2026 Client Facture N° : FV06286-2026
        Irrakids Sarl  Irrakids Nbr des Commandes : 3
        Référence La Ville Montant Tarif Refusé Retour Dépenses Reste
        7-161446 MEKNES 300,00 15,00 0,00 0,00 0,00 285,00 Livrée - 15-08-2026 14:30
        160935 FES 299,00 15,00 0,00 0,00 0,00 284,00 Livrée - 15-08-2026 17:38
        158437 TAOUNATE 477,00 23,00 0,00 0,00 0,00 454,00 Livrée - 14-08-2026 18:02
        Totaux 1076,00 53,00 0,00 0,00 0,00 1023,00
        Total Commandes Reste Commandes Extras Total 1076,00 MAD 1023,00 MAD 0,00 MAD 1023,00 MAD""")
    # 1076 and 1023 are four digits on their own: only the decimal comma tells
    # them apart from an order reference.
    assert [r["sendCode"] for r in result["rows"]] == ["7-161446", "160935", "158437"]
    assert [r["orderNumber"] for r in result["rows"]] == ["161446", "160935", "158437"]
    assert [r["city"] for r in result["rows"]] == ["MEKNES", "FES", "TAOUNATE"]
    assert result["validation"]["warnings"] == []
    assert result["validation"]["complete"] is True
