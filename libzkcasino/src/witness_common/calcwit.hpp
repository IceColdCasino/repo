#ifndef CIRCOM_CALCWIT_H
#define CIRCOM_CALCWIT_H

#include <mutex>
#include <condition_variable>
#include <functional>
#include <atomic>
#include <memory>

#include "circom.hpp"
#include "fr.hpp"

#define NMUTEXES 32 //512

u64 fnv1a(std::string s);

class Circom_CalcWit {

  Circom_Circuit *circuit;

  // Opaque handle to Zig implementation
  void* zig_ctx;

public:

  FrElement *signalValues;
  Circom_Component* componentMemory;
  FrElement* circuitConstants; 
  std::map<u32,IOFieldDefPair> templateInsId2IOSignalInfo; 
  IOFieldDefPair* busInsId2FieldInfo;
  std::string* listOfTemplateMessages; 

  // parallelism
  std::mutex numThreadMutex;
  std::condition_variable ntcvs;
  int numThread;

  int maxThread;
  
  uint num_components;

  // Functions called by the circuit
  Circom_CalcWit(Circom_Circuit *aCircuit, uint numTh = NMUTEXES);
  ~Circom_CalcWit();

  void reset();

  // Public functions
  void setInputSignal(u64 h, uint i, FrElement &val);
  void tryRunCircuit();
  
  u64 getInputSignalSize(u64 h);
  
  void* getZigCtx() { return zig_ctx; }

  // Non-inline: delegates to Zig implementation
  uint getRemaingInputsToBeSet();
  
  // Inline: accesses C++ pointers directly (efficient for generated code)
  inline void getWitness(uint idx, PFrElement val) {
    Fr_copy(val, &signalValues[circuit->witness2SignalList[idx]]);
  }

  std::string getTrace(u64 id_cmp);

  std::string generate_position_array(uint* dimensions, uint size_dimensions, uint index);

private:
  
  uint getInputSignalHashPosition(u64 h);

};

typedef void (*Circom_TemplateFunction)(uint __cIdx, Circom_CalcWit* __ctx); 

#endif // CIRCOM_CALCWIT_H
