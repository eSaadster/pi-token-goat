/**
 * Adversarial-parity regression lock for repomap PageRank.
 *
 * The TS `compute_ranks` re-implements networkx's pure-Python `_pagerank_python`
 * + `stochastic_graph` (node/edge iteration order + float accumulation order
 * preserved). This file locks that against the CPython `.venv` oracle: each
 * graph below was run through the REAL Python `token_goat.repomap.compute_ranks`
 * (networkx-backed) and its rank vector hardcoded here. Differential fuzzing
 * (14 graphs, up to 100 nodes / 400 edges, incl. self-loops / multi-edges /
 * dangling / cycles) showed max divergence of 1.1e-16 (one ULP) — far below the
 * 3-decimal precision the map output exposes, so rendered ranks are byte-
 * identical. Runs with NO .venv dependency; expected values are frozen from the
 * oracle. Guards against silent regression of the power-iteration math.
 */
import { describe, expect, it } from "vitest";

import * as repomap from "../src/token_goat/repomap.js";

interface GraphLock {
  spec: { nodes: string[]; edges: Array<[string, string]> };
  ranks: Record<string, number>;
}

// Frozen oracle: token_goat.repomap.compute_ranks() under CPython 3.13 + networkx.
const ORACLE: Record<string, GraphLock> = {"linear":{"spec":{"nodes":["A","B","C"],"edges":[["A","B"],["B","C"]]},"ranks":{"A":0.1844167633067642,"B":0.3411716203526378,"C":0.47441161634059753}},"cycle":{"spec":{"nodes":["A","B","C"],"edges":[["A","B"],["B","C"],["C","A"]]},"ranks":{"A":0.3333333333333333,"B":0.3333333333333333,"C":0.3333333333333333}},"selfloop":{"spec":{"nodes":["A","B"],"edges":[["A","A"],["A","B"]]},"ranks":{"A":0.5,"B":0.5}},"isolated":{"spec":{"nodes":["X","Y","Z"],"edges":[]},"ranks":{"X":0.3333333333333333,"Y":0.3333333333333333,"Z":0.3333333333333333}},"hub":{"spec":{"nodes":["h","a","b","c","d"],"edges":[["a","h"],["b","h"],["c","h"],["d","h"],["a","b"]]},"ranks":{"h":0.49493454042056995,"a":0.11413913258781822,"b":0.16264806181597574,"c":0.11413913258781822,"d":0.11413913258781822}},"multi":{"spec":{"nodes":["A","B","C"],"edges":[["A","B"],["A","B"],["A","B"],["B","C"],["A","C"]]},"ranks":{"A":0.19077155005247032,"B":0.3123880943767382,"C":0.49684035557079126}},"dangling":{"spec":{"nodes":["A","B","C","D"],"edges":[["A","B"],["B","C"]]},"ranks":{"A":0.15570285940036888,"B":0.28804972339985113,"C":0.400544557799411,"D":0.15570285940036888}},"rand2":{"spec":{"nodes":["f0","f1","f2","f3","f4","f5","f6","f7","f8","f9","f10","f11","f12","f13","f14","f15","f16","f17","f18","f19","f20","f21","f22","f23","f24","f25","f26","f27","f28","f29","f30","f31","f32","f33","f34","f35","f36","f37","f38","f39","f40","f41","f42","f43","f44","f45","f46","f47","f48","f49"],"edges":[["f5","f25"],["f13","f3"],["f18","f2"],["f14","f32"],["f5","f44"],["f20","f19"],["f29","f4"],["f37","f16"],["f4","f44"],["f27","f12"],["f6","f25"],["f12","f45"],["f29","f32"],["f15","f23"],["f13","f32"],["f44","f26"],["f11","f37"],["f13","f19"],["f3","f22"],["f34","f9"],["f31","f49"],["f35","f30"],["f21","f8"],["f8","f3"],["f39","f10"],["f9","f34"],["f4","f45"],["f20","f10"],["f0","f42"],["f43","f3"],["f40","f5"],["f48","f9"],["f13","f2"],["f27","f25"],["f47","f20"],["f13","f43"],["f24","f17"],["f34","f40"],["f19","f27"],["f20","f43"],["f36","f9"],["f34","f5"],["f48","f16"],["f17","f26"],["f25","f36"],["f17","f33"],["f7","f44"],["f24","f17"],["f13","f19"],["f45","f37"],["f25","f3"],["f22","f28"],["f14","f49"],["f31","f10"],["f24","f19"],["f0","f4"],["f30","f25"],["f19","f27"],["f43","f30"],["f11","f25"],["f40","f30"],["f10","f18"],["f37","f23"],["f41","f38"],["f22","f13"],["f10","f33"],["f36","f29"],["f42","f30"],["f42","f1"],["f46","f29"],["f42","f6"],["f1","f23"],["f30","f4"],["f8","f37"],["f21","f22"],["f48","f48"],["f18","f19"],["f43","f43"],["f37","f21"],["f36","f18"],["f36","f12"],["f32","f47"],["f17","f4"],["f34","f44"],["f38","f13"],["f21","f32"],["f21","f20"],["f29","f17"],["f5","f48"],["f33","f37"],["f37","f35"],["f7","f15"],["f16","f23"],["f8","f1"],["f25","f2"],["f42","f2"],["f13","f42"],["f9","f20"],["f33","f22"],["f27","f32"],["f4","f48"],["f19","f16"],["f44","f31"],["f37","f14"],["f22","f32"],["f5","f41"],["f1","f43"],["f37","f21"],["f36","f14"],["f10","f30"],["f31","f43"],["f43","f8"],["f34","f39"],["f39","f4"],["f9","f34"],["f15","f44"],["f10","f32"],["f48","f32"],["f44","f49"],["f25","f20"]]},"ranks":{"f0":0.004937147951608354,"f1":0.011996234296624537,"f2":0.023505871597895432,"f3":0.02966247955345171,"f4":0.03077528777988218,"f5":0.010085345499224402,"f6":0.0070888385652881514,"f7":0.004937147951608354,"f8":0.017318725618261675,"f9":0.013503238411075797,"f10":0.02796496710495676,"f11":0.004937147951608354,"f12":0.014091548127224476,"f13":0.02544894979771392,"f14":0.012719342816142263,"f15":0.007035431154516296,"f16":0.024689368033738703,"f17":0.010935343927842869,"f18":0.013042152750159146,"f19":0.03483187295121279,"f20":0.059198750122839844,"f21":0.01617667206660473,"f22":0.039528816015364086,"f23":0.03963196844093031,"f24":0.004937147951608354,"f25":0.03662918650633182,"f26":0.014560303467710369,"f27":0.02467516061628742,"f28":0.016136473262803666,"f29":0.011296147164459957,"f30":0.03395669480310303,"f31":0.011461941746656766,"f32":0.04846805551296762,"f33":0.01397808166417703,"f34":0.012588991080966526,"f35":0.010556910009106543,"f36":0.012720763775775993,"f37":0.03967168747567606,"f38":0.010955527130783058,"f39":0.007077353911747448,"f40":0.007077353911747448,"f41":0.007080354557306753,"f42":0.010125605323463894,"f43":0.042089569489011824,"f44":0.023028544038942476,"f45":0.02563406420756971,"f46":0.004937147951608354,"f47":0.04613583000257393,"f48":0.020063464592379752,"f49":0.02011499135945906}}};

describe("ParityRepomapPageRankCpython", () => {
  for (const [name, entry] of Object.entries(ORACLE)) {
    it(`compute_ranks parity: ${name}`, () => {
      const g = new repomap.MultiDiGraph();
      for (const n of entry.spec.nodes) g.add_node(n);
      for (const [u, v] of entry.spec.edges) g.add_edge(u, v);
      const ranks = repomap.compute_ranks(g);

      expect(new Set(ranks.keys())).toEqual(new Set(Object.keys(entry.ranks)));
      for (const [node, pyVal] of Object.entries(entry.ranks)) {
        // Bit-exact within one ULP of the Python oracle.
        expect(Math.abs(ranks.get(node)! - pyVal)).toBeLessThan(1e-12);
      }
    });
  }
});
