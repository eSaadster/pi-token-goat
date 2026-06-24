/**
 * Public entry point for the token-goat TS port.
 *
 * The seed surface is just entropy; subsequent layers re-export here as they
 * land (paths, util, config, db, render, ...), mirroring src/token_goat/__init__.py.
 */
export {
  _ENTROPY_MIN_LEN,
  _ENTROPY_THRESHOLD,
  hasHighEntropyToken,
  scoreEntropy,
} from "./entropy.js";
