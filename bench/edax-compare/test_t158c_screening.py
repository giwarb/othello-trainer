import importlib.util, json, tempfile, unittest
from pathlib import Path
HERE=Path(__file__).resolve().parent; SPEC=importlib.util.spec_from_file_location("t158c",HERE/"t158c_screening.py"); t158c=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(t158c)
class Tests(unittest.TestCase):
    def test_stage_known_harm(self):
        r={x["seed"]:x for x in t158c.stage_triage()}; self.assertFalse(r[1]["frozenPassForSeedSelection"]); self.assertTrue(r[2]["frozenPassForSeedSelection"]); self.assertFalse(r[3]["frozenPassForSeedSelection"]); self.assertEqual(r[1]["maxRegression"]["emptyCount"],43); self.assertEqual(r[3]["maxRegression"]["emptyCount"],46)
    def test_selection_is_harm_only(self):
        s=[{"seed":1,"frozenPassForSeedSelection":False,"maxRegression":{"delta":.2}},{"seed":2,"frozenPassForSeedSelection":True,"maxRegression":{"delta":.01}},{"seed":3,"frozenPassForSeedSelection":True,"maxRegression":{"delta":.05}}]; o={"results":{f"seed{x}":{"gate4Pass":True} for x in (1,2,3)}}; self.assertEqual(t158c.choose_seed(s,o),2); o["results"]["seed2"]["gate4Pass"]=False; self.assertEqual(t158c.choose_seed(s,o),3)
    def test_atomic(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"x.json"; t158c.atomic(p,{"x":1}); t158c.atomic(p,{"x":2}); self.assertEqual(json.loads(p.read_text()),{"x":2}); self.assertEqual(list(Path(d).glob("*.tmp")),[])
if __name__=="__main__": unittest.main()
