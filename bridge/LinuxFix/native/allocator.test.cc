#include <cassert>
#include <cstdint>
#include <cstring>
#include <sys/mman.h>
#include <unistd.h>
#include "dobby.h"
#include "MemoryAllocator/NearMemoryAllocator.h"

static uintptr_t replacement(int) { return 99; }

int main() {
  const size_t page = sysconf(_SC_PAGESIZE);
  const size_t length = 5ULL * 1024 * 1024 * 1024;
  auto *region = static_cast<unsigned char *>(mmap(nullptr, length, PROT_NONE,
                                                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
  assert(region != MAP_FAILED);
  auto *victim = region + length / 2;
  assert(mprotect(victim, 4 * page, PROT_READ | PROT_WRITE) == 0);
  memset(victim, 0x90, page);
  memset(victim + page, 0, page);
  memset(victim + 2 * page, 0x5a, page);
  assert(OSMemory::Allocate(page, kReadExecute, victim + 2 * page) == nullptr);
  assert(victim[2 * page] == 0x5a);
  assert(mprotect(victim + page, page, PROT_READ | PROT_EXEC) == 0);

  auto data = gNearMemoryAllocator.allocNearDataBlock(8, (addr_t)victim, 4 * page);
  assert(data.addr() == 0);
  auto code = gNearMemoryAllocator.allocNearCodeBlock(8, (addr_t)victim, 4 * page);
  assert(code.addr() == 0);

  const unsigned char bodies[][24] = {
      {0xb8, 7, 0, 0, 0},
      {0x8b, 0x05, 0, 0, 0, 0, 0x83, 0xc0, 1},
      {0x48, 0x8d, 0x05, 0, 0, 0, 0},
      {0x85, 0xff, 0x0f, 0x84, 56, 0, 0, 0, 0xb8, 9, 0, 0, 0},
  };
  const size_t sizes[] = {5, 9, 7, 13};
  for (size_t i = 0; i < 4; ++i) {
    assert(mprotect(victim, page, PROT_READ | PROT_WRITE) == 0);
    memset(victim, 0x90, page);
    memcpy(victim, bodies[i], sizes[i]);
    victim[24] = 0xc3;
    const unsigned char branch_body[] = {0xb8, 7, 0, 0, 0, 0xc3};
    memcpy(victim + 64, branch_body, sizeof(branch_body));
    if (i == 1 || i == 2) {
      const size_t displacement_offset = i == 1 ? 2 : 3;
      const int32_t displacement = 2 * page - (displacement_offset + 4);
      memcpy(victim + displacement_offset, &displacement, 4);
      uint32_t value = 41;
      memcpy(victim + 2 * page, &value, 4);
    }
    assert(mprotect(victim, page, PROT_READ | PROT_EXEC) == 0);
    using Function = uintptr_t (*)(int);
    auto call = reinterpret_cast<Function>(victim);
    const uintptr_t expected[] = {call(0), call(1)};
    if (i == 0) assert(expected[0] == 7 && expected[1] == 7);
    if (i == 1) assert(expected[0] == 42 && expected[1] == 42);
    if (i == 2) assert(expected[0] == reinterpret_cast<uintptr_t>(victim + 2 * page));
    if (i == 3) assert(expected[0] == 7 && expected[1] == 9);
    void *original = nullptr;
    assert(DobbyHook(victim, reinterpret_cast<void *>(replacement), &original) == 0);
    assert(original != nullptr && call(0) == 99 && call(1) == 99);
    auto distance = reinterpret_cast<uintptr_t>(original) > reinterpret_cast<uintptr_t>(victim)
        ? reinterpret_cast<uintptr_t>(original) - reinterpret_cast<uintptr_t>(victim)
        : reinterpret_cast<uintptr_t>(victim) - reinterpret_cast<uintptr_t>(original);
    assert(distance > 2ULL * 1024 * 1024 * 1024);
    auto unhooked = reinterpret_cast<Function>(original);
    assert(unhooked(0) == expected[0] && unhooked(1) == expected[1]);
    assert(DobbyDestroy(victim) == 0);
    assert(call(0) == expected[0] && call(1) == expected[1]);
    for (size_t n = 0; n < page; ++n) assert(victim[page + n] == 0);
  }
  assert(munmap(region, length) == 0);
}
