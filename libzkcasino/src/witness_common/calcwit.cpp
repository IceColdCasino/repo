#include <iomanip>
#include <sstream>
#include <assert.h>
#include "calcwit.hpp"
#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

// Parallel circom witness threads use default pthread stacks (~512 KiB on iOS sim),
// which can overflow on large circuits. Register is small; keep default thread pool.
static constexpr uint kWitnessMaxThreads = 32;

// C API exports from Zig calcwit.zig
extern "C" {
    void* zkcasino_calcwit_create_with_run(void* circuit, void (*run_fn)(void*));
    void zkcasino_calcwit_destroy(void* ctx);
    void zkcasino_calcwit_set_input_signal(void* ctx, uint64_t h, uint32_t i, FrElement* val);
    void zkcasino_calcwit_try_run_circuit(void* ctx);
    uint64_t zkcasino_calcwit_get_input_signal_size(void* ctx, uint64_t h);
    uint32_t zkcasino_calcwit_remaining_inputs(void* ctx);
    void zkcasino_calcwit_get_witness(void* ctx, uint32_t idx, FrElement* val);
    const char* zkcasino_calcwit_get_trace(void* ctx, uint64_t id_cmp);
    const char* zkcasino_calcwit_generate_position_array(void* ctx, uint32_t* dimensions, uint32_t size_dimensions, uint32_t index);
    FrElement* zkcasino_calcwit_get_signal_values(void* ctx);
    FrElement* zkcasino_calcwit_get_circuit_constants(void* ctx);
    void zkcasino_calcwit_set_cpp_ctx(void* ctx, void* cpp_ctx);
    void zkcasino_calcwit_delete_cpp_ctx(void* cpp_ctx);
    void zkcasino_calcwit_reset_cpp_ctx(void* cpp_ctx);
    void* zkcasino_calcwit_get_zig_ctx(void* cpp_ctx);
}

extern "C" uint64_t fnv1a(const char* str);

// Each circuit compiles this file with its own prefix header. These symbols are
// identical across circuits and are not renamed, so more than one object in a
// game library defines them. Weak lets the linker keep a single copy.
__attribute__((weak)) u64 fnv1a(std::string s) {
    return ::fnv1a(s.c_str());
}

// run is defined in the generated circuit file (renamed by prefix header).
// It has C++ linkage, so it cannot be cast to a C function pointer for Zig.
extern void run(Circom_CalcWit* ctx);


extern "C" void run_c_bridge(void* ctx) {
    run((Circom_CalcWit*)ctx);
}

static void initComponentSlot(Circom_Component& c) {
    c.templateId = 0;
    c.signalStart = 0;
    c.inputCounter = 0;
    c.templateName.clear();
    c.componentName.clear();
    c.idFather = 0;
    c.subcomponents = nullptr;
    c.subcomponentsParallel = nullptr;
    c.outputIsSet = nullptr;
    c.mutexes = nullptr;
    c.cvs = nullptr;
    c.sbct = nullptr;
}

static void releaseComponentAllocations(Circom_Component& c) {
    if (c.subcomponents) delete[] c.subcomponents;
    if (c.subcomponentsParallel) delete[] c.subcomponentsParallel;
    if (c.outputIsSet) delete[] c.outputIsSet;
    if (c.mutexes) delete[] c.mutexes;
    if (c.cvs) delete[] c.cvs;
    if (c.sbct) delete[] c.sbct;
}

// Context creation for Zig management layer
extern "C" void* create_ctx(void* circuit) {
    auto* ctx = new Circom_CalcWit((Circom_Circuit*)circuit, kWitnessMaxThreads);
    return ctx;
}

Circom_CalcWit::Circom_CalcWit(Circom_Circuit *aCircuit, uint maxTh) {
    circuit = aCircuit;
    zig_ctx = zkcasino_calcwit_create_with_run(aCircuit, run_c_bridge);
    signalValues = zkcasino_calcwit_get_signal_values(zig_ctx);
    circuitConstants = zkcasino_calcwit_get_circuit_constants(zig_ctx);
    templateInsId2IOSignalInfo = aCircuit->templateInsId2IOSignalInfo;
    busInsId2FieldInfo = aCircuit->busInsId2FieldInfo;
    listOfTemplateMessages = nullptr;
    maxThread = maxTh;
    numThread = 0;
    // componentMemory is allocated in C++ with correct Circom_Component struct layout
    num_components = get_number_of_components();
    componentMemory = new Circom_Component[num_components]();
    for (uint i = 0; i < num_components; i++) {
        initComponentSlot(componentMemory[i]);
    }
    zkcasino_calcwit_set_cpp_ctx(zig_ctx, this);
}

void Circom_CalcWit::reset() {
    for (uint i = 0; i < num_components; i++) {
        componentMemory[i].inputCounter = 0;
    }
    numThread = 0;
}

Circom_CalcWit::~Circom_CalcWit() {
    for (uint i = 0; i < num_components; i++) {
        releaseComponentAllocations(componentMemory[i]);
    }
    delete[] componentMemory;
    zkcasino_calcwit_destroy(zig_ctx);
}

extern "C" __attribute__((weak)) void zkcasino_calcwit_reset_cpp_ctx(void* cpp_ctx) {
    if (!cpp_ctx) return;
    static_cast<Circom_CalcWit*>(cpp_ctx)->reset();
}

uint Circom_CalcWit::getInputSignalHashPosition(u64 h) {
    return 0; // Not used; handled by Zig implementation
}

void Circom_CalcWit::tryRunCircuit() {
    zkcasino_calcwit_try_run_circuit(zig_ctx);
}

void Circom_CalcWit::setInputSignal(u64 h, uint i, FrElement &val) {
    zkcasino_calcwit_set_input_signal(zig_ctx, h, i, &val);
}

u64 Circom_CalcWit::getInputSignalSize(u64 h) {
    return zkcasino_calcwit_get_input_signal_size(zig_ctx, h);
}

uint Circom_CalcWit::getRemaingInputsToBeSet() {
    return zkcasino_calcwit_remaining_inputs(zig_ctx);
}

std::string Circom_CalcWit::getTrace(u64 id_cmp) {
    const char* trace = zkcasino_calcwit_get_trace(zig_ctx, id_cmp);
    return std::string(trace);
}

std::string Circom_CalcWit::generate_position_array(uint* dimensions, uint size_dimensions, uint index) {
    const char* pos = zkcasino_calcwit_generate_position_array(zig_ctx, dimensions, size_dimensions, index);
    return std::string(pos);
}

extern "C" __attribute__((weak)) void zkcasino_calcwit_get_witness_cpp(void* cpp_ctx, uint32_t idx, FrElement* val) {
    static_cast<Circom_CalcWit*>(cpp_ctx)->getWitness(idx, val);
}

extern "C" __attribute__((weak)) void zkcasino_calcwit_delete_cpp_ctx(void* cpp_ctx) {
    delete (Circom_CalcWit*)cpp_ctx;
}

extern "C" __attribute__((weak)) void* zkcasino_calcwit_get_zig_ctx(void* cpp_ctx) {
    return ((Circom_CalcWit*)cpp_ctx)->getZigCtx();
}
