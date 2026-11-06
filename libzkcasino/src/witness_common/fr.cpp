#include "fr.hpp"

// Field arithmetic lives in fr_inline.hpp and in the Zig witness.
// This translation unit keeps libfr present for the app link line.
extern "C" void fr_keep_libfr(void) {}
