import gyp from "./gyp";
import bootNexe from "./third-party-main";
import buildFixes from "./build-fixes";
import cli from "./disable-node-cli";
import flags from "./flags";
import ico from "./ico";
import rc from "./node-rc";
import snapshot from "./snapshot";
import fsStat from "./fs-stat-debug";

// Patches are applied in order, so if a patch depends on another patch, it should be listed after the patch it depends on.
// For example, if a patch modifies the output of gyp, it should be listed after gyp in this array.
const patches = [gyp, bootNexe, buildFixes, cli, flags, ico, rc, snapshot];

export default patches;
