// main_bridge.cpp - Extract just the needed functions from main.cpp
// without the main() function

#include <cstring>
#include <string>
#include <sys/stat.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <map>
#include <cassert>

#include "circom.hpp"
#include <cstddef>

// Must match calcwit.zig CircomCircuit layout (64 bytes with 24-byte std::map).
static_assert(sizeof(std::map<u32, IOFieldDefPair>) == 24, "std::map size changed; update calcwit.zig _padding");
static_assert(sizeof(Circom_Circuit) == 64, "Circom_Circuit size changed; update calcwit.zig CircomCircuit");
static_assert(offsetof(Circom_Circuit, circuitConstants) == 16, "circuitConstants offset mismatch");
static_assert(offsetof(Circom_Circuit, busInsId2FieldInfo) == 48, "busInsId2FieldInfo offset mismatch");
static_assert(offsetof(Circom_Circuit, vtable) == 56, "vtable offset mismatch");

// fnv1a is already defined in calcwit.o

// Load circuit from a memory buffer instead of a file
// Uses heap allocation for all temporary arrays to avoid stack overflow
extern "C" Circom_Circuit* loadCircuitFromData(const uint8_t* data, size_t size, const void* vtable) {
    Circom_Circuit *circuit = new Circom_Circuit();

    const u8* bdata = (const u8*)data;

    // Fail closed on circuit/.dat skew (stale iOS witness objects historically
    // crashed in memmove while parsing the IO map).
    const size_t min_prefix =
        (size_t)get_size_of_input_hashmap() * sizeof(HashSignalInfo) +
        (size_t)get_size_of_witness() * sizeof(u64) +
        (size_t)get_size_of_constants() * sizeof(FrElement) +
        (size_t)get_size_of_io_map() * sizeof(u32);
    if (data == nullptr || size < min_prefix) {
        delete circuit;
        return nullptr;
    }

    circuit->InputHashMap = new HashSignalInfo[get_size_of_input_hashmap()];
    uint dsize = get_size_of_input_hashmap()*sizeof(HashSignalInfo);
    {
        // @embedFile / dylib rodata may be misaligned for HashSignalInfo reads on ARM64.
        auto* aligned = new HashSignalInfo[get_size_of_input_hashmap()];
        memcpy(aligned, bdata, dsize);
        memcpy(circuit->InputHashMap, aligned, dsize);
        delete[] aligned;
    }

    circuit->witness2SignalList = new u64[get_size_of_witness()];
    uint inisize = dsize;
    dsize = get_size_of_witness()*sizeof(u64);
    {
        auto* aligned = new u64[get_size_of_witness()];
        memcpy(aligned, bdata + inisize, dsize);
        memcpy(circuit->witness2SignalList, aligned, dsize);
        delete[] aligned;
    }

    circuit->circuitConstants = new FrElement[get_size_of_constants()];
    if (get_size_of_constants()>0) {
      inisize += dsize;
      dsize = get_size_of_constants()*sizeof(FrElement);
      auto* aligned = new FrElement[get_size_of_constants()];
      memcpy(aligned, bdata + inisize, dsize);
      memcpy(circuit->circuitConstants, aligned, dsize);
      delete[] aligned;
    }

    std::map<u32,IOFieldDefPair> templateInsId2IOSignalInfo1;
    IOFieldDefPair* busInsId2FieldInfo1 = nullptr;
    if (get_size_of_io_map()>0) {
      inisize += dsize;
      dsize = get_size_of_io_map()*sizeof(u32);
      
      // Use heap allocation for index array
      u32* index = new u32[get_size_of_io_map()];
      memcpy((void *)index, (void *)(bdata+inisize), dsize);
      inisize += dsize;
      
      assert(inisize <= size);
      assert(size % sizeof(u32) == 0);
      assert(inisize % sizeof(u32) == 0);

      // Copy to aligned heap buffer — @embedFile data may be misaligned for u32 reads.
      const size_t io_bytes = size - inisize;
      u32* dataiomap = new u32[io_bytes / sizeof(u32)];
      memcpy((void*)dataiomap, (void*)(bdata + inisize), io_bytes);
      const u32* pu32 = dataiomap;
      
      for (int i = 0; i < get_size_of_io_map(); i++) {
        u32 n = *pu32;
        IOFieldDefPair p;
        p.len = n;
        p.defs = (IOFieldDef*)calloc(p.len, sizeof(IOFieldDef));
        pu32 += 1;
        for (u32 j = 0; j < n; j++){
          p.defs[j].offset = *pu32;
          u32 len = *(pu32 + 1);
          p.defs[j].len = len;
          p.defs[j].lengths = new u32[len];
          memcpy((void *)p.defs[j].lengths, (void *)(pu32 + 2), len*sizeof(u32));
          pu32 += len + 2;
          p.defs[j].size = *pu32;
          p.defs[j].busId = *(pu32 + 1);      
          pu32 += 2;
        }
        templateInsId2IOSignalInfo1[index[i]] = p;
      }
      
      delete[] index;
      
      busInsId2FieldInfo1 = (IOFieldDefPair*)calloc(get_size_of_bus_field_map(), sizeof(IOFieldDefPair));
      for (int i = 0; i < get_size_of_bus_field_map(); i++) {
        u32 n = *pu32;
        IOFieldDefPair p;
        p.len = n;
        p.defs = (IOFieldDef*)calloc(10, sizeof(IOFieldDef));
        pu32 += 1;
        for (u32 j = 0; j < n; j++){
          p.defs[j].offset = *pu32;
          u32 len = *(pu32 + 1);
          p.defs[j].len = len;
          p.defs[j].lengths = new u32[len];
          memcpy((void *)p.defs[j].lengths, (void *)(pu32 + 2), len*sizeof(u32));
          pu32 += len + 2;
          p.defs[j].size = *pu32;
          p.defs[j].busId = *(pu32 + 1);      
          pu32 += 2;
        }
        busInsId2FieldInfo1[i] = p;
      }
      delete[] dataiomap;
    }
    circuit->templateInsId2IOSignalInfo = std::move(templateInsId2IOSignalInfo1);
    circuit->busInsId2FieldInfo = busInsId2FieldInfo1;
    circuit->vtable = vtable;
    return circuit;
}

Circom_Circuit* loadCircuit(std::string const &datFileName) {
    Circom_Circuit *circuit = new Circom_Circuit();

    int fd;
    struct stat sb;

    fd = open(datFileName.c_str(), O_RDONLY);
    if (fd == -1) {
        throw std::system_error(errno, std::generic_category(), "open");
    }
    
    if (fstat(fd, &sb) == -1) {
        throw std::system_error(errno, std::generic_category(), "fstat");
    }

    u8* bdata = (u8*)mmap(NULL, sb.st_size, PROT_READ , MAP_PRIVATE, fd, 0);
    close(fd);

    circuit->InputHashMap = new HashSignalInfo[get_size_of_input_hashmap()];
    uint dsize = get_size_of_input_hashmap()*sizeof(HashSignalInfo);
    memcpy((void *)(circuit->InputHashMap), (void *)bdata, dsize);

    circuit->witness2SignalList = new u64[get_size_of_witness()];
    uint inisize = dsize;    
    dsize = get_size_of_witness()*sizeof(u64);
    memcpy((void *)(circuit->witness2SignalList), (void *)(bdata+inisize), dsize);

    circuit->circuitConstants = new FrElement[get_size_of_constants()];
    if (get_size_of_constants()>0) {
      inisize += dsize;
      dsize = get_size_of_constants()*sizeof(FrElement);
      auto* aligned = new FrElement[get_size_of_constants()];
      memcpy(aligned, bdata + inisize, dsize);
      memcpy(circuit->circuitConstants, aligned, dsize);
      delete[] aligned;
    }

    std::map<u32,IOFieldDefPair> templateInsId2IOSignalInfo1;
    IOFieldDefPair* busInsId2FieldInfo1;
    if (get_size_of_io_map()>0) {
      u32 index[get_size_of_io_map()];
      inisize += dsize;
      dsize = get_size_of_io_map()*sizeof(u32);
      memcpy((void *)index, (void *)(bdata+inisize), dsize);
      inisize += dsize;
      assert(inisize % sizeof(u32) == 0);    
      assert(sb.st_size % sizeof(u32) == 0);
      u32 dataiomap[(sb.st_size-inisize)/sizeof(u32)];
      memcpy((void *)dataiomap, (void *)(bdata+inisize), sb.st_size-inisize);
      u32* pu32 = dataiomap;
      for (int i = 0; i < get_size_of_io_map(); i++) {
    u32 n = *pu32;
    IOFieldDefPair p;
    p.len = n;
    IOFieldDef defs[n];
    pu32 += 1;
    for (u32 j = 0; j <n; j++){
      defs[j].offset=*pu32;
      u32 len = *(pu32+1);
      defs[j].len = len;
      defs[j].lengths = new u32[len];
      memcpy((void *)defs[j].lengths,(void *)(pu32+2),len*sizeof(u32));
      pu32 += len + 2;
      defs[j].size=*pu32;
      defs[j].busId=*(pu32+1);      
      pu32 += 2;
    }
    p.defs = (IOFieldDef*)calloc(p.len, sizeof(IOFieldDef));
    for (u32 j = 0; j < p.len; j++){
      p.defs[j] = defs[j];
    }
    templateInsId2IOSignalInfo1[index[i]] = p;
      }
      busInsId2FieldInfo1 = (IOFieldDefPair*)calloc(get_size_of_bus_field_map(), sizeof(IOFieldDefPair));
      for (int i = 0; i < get_size_of_bus_field_map(); i++) {
    u32 n = *pu32;
    IOFieldDefPair p;
    p.len = n;
    IOFieldDef defs[n];
    pu32 += 1;
    for (u32 j = 0; j <n; j++){
      defs[j].offset=*pu32;
      u32 len = *(pu32+1);
      defs[j].len = len;
      defs[j].lengths = new u32[len];
      memcpy((void *)defs[j].lengths,(void *)(pu32+2),len*sizeof(u32));
      pu32 += len + 2;
      defs[j].size=*pu32;
      defs[j].busId=*(pu32+1);      
      pu32 += 2;
    }
    p.defs = (IOFieldDef*)calloc(10, sizeof(IOFieldDef));
    for (u32 j = 0; j < p.len; j++){
      p.defs[j] = defs[j];
    }
    busInsId2FieldInfo1[i] = p;
      }
    }
    circuit->templateInsId2IOSignalInfo = std::move(templateInsId2IOSignalInfo1);
    circuit->busInsId2FieldInfo = busInsId2FieldInfo1;

    munmap(bdata, sb.st_size);
    
    return circuit;
}
