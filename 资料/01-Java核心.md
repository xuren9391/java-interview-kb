# Java 核心（源码级 · JVM · 并发 · 集合 · IO · 线上案例）

> 难度：🟢必会 🟡进阶 🔴高阶（专家级）
> 这是后端面试基本盘，几乎每场必问，且最容易拉开差距。
> **本文档目标：从 API 级讲到源码/内核级 + 设计动机 + 大量图解 + 线上实战案例。**

---

# 第一篇 JVM（讲透到 G1/ZGC 调优与 OOM 实战）

## 1.1 运行时数据区（JDK8+ 全景图）

```
┌──────────────────────────────────────────────────────────────┐
│                        JVM 运行时数据区                        │
├─────────────────────────────┬────────────────────────────────┤
│      线程共享（随 JVM 存在）  │         线程私有（随线程存在）    │
├─────────────────────────────┼────────────────────────────────┤
│  ┌───────────────────────┐  │  ┌──────────────────────────┐  │
│  │   堆 Heap（最大）      │  │  │  虚拟机栈 VM Stack        │  │
│  │  ┌──────┬──────────┐  │  │  │  ┌────────────────────┐  │  │
│  │  │新生代 │  老年代   │  │  │  │  │ 栈帧 Frame         │  │  │
│  │  │Eden  │          │  │  │  │  │ ├ 局部变量表        │  │  │
│  │  │S0 S1 │          │  │  │  │  │ ├ 操作数栈          │  │  │
│  │  └──────┴──────────┘  │  │  │  │ ├ 动态链接          │  │  │
│  └───────────────────────┘  │  │  │ └ 方法返回地址      │  │  │
│  ┌───────────────────────┐  │  │  └────────────────────┘  │  │
│  │ 方法区(元空间)         │  │  └──────────────────────────┘  │
│  │ Metaspace(本地内存)    │  │  ┌──────────────────────────┐  │
│  │ 类信息/常量池/静态变量  │  │  │  本地方法栈 Native Stack  │  │
│  └───────────────────────┘  │  └──────────────────────────┘  │
│                              │  ┌──────────────────────────┐  │
│                              │  │  程序计数器 PC Register   │  │
│                              │  │  (记录当前执行字节码地址) │  │
│                              │  └──────────────────────────┘  │
└──────────────────────────────┴────────────────────────────────┘
        + 直接内存 Direct Memory（NIO 堆外，受 MaxDirectMemorySize 限制）
```

### 🔴 必须讲清的 6 个深度点

**① 永久代 → 元空间的演进（JDK8）**
| | 永久代（JDK7-） | 元空间（JDK8+） |
|---|---|---|
| 位置 | JVM 堆的一部分 | **本地内存（Native Memory）** |
| 大小限制 | -XX:MaxPermSize（固定，易 OOM） | -XX:MaxMetaspaceSize（默认无上限，受物理内存） |
| 存什么 | 类信息、常量池、静态变量 | 类信息、常量池（静态变量移到堆） |

**为什么废弃永久代？** 🔴
1. 永久代大小固定，调优困难。动态生成类多（CGLIB、Groovy、JSP、反射）容易 `OutOfMemoryError: PermGen space`。
2. 字符串常量池（intern）JDK7 移到堆，JDK8 彻底移除永久代，避免 PermGen OOM。
3. JRockit 和 Hotspot 融合的需要（JRockit 没有永久代）。
4. 元空间用本地内存，GC 扫描范围小，full GC 更快。

**② 为什么程序计数器是线程私有的？**
- 字节码解释器靠 PC 决定下一条执行什么。多线程切换后回来，必须从自己上次的位置继续，所以每线程一个 PC。

**③ 为什么虚拟机栈/本地方法栈是线程私有的？**
- 栈帧存局部变量、操作数栈。每个方法调用一个栈帧。私有保证各线程方法调用互不干扰。
- 栈深固定（-Xss，默认 512K-1M），递归太深 → `StackOverflowError`。

**④ 直接内存（Direct Memory）**
- NIO 的 `ByteBuffer.allocateDirect()` 用堆外内存，不受 JVM 堆大小控制，但受 `-XX:MaxDirectMemorySize` 限制。
- **优点**：减少一次内核态→用户态拷贝（零拷贝），GC 不扫描（减少 GC 压力）。
- **缺点**：分配/回收成本高（Unsafe.allocateMemory），无法被 JVM 直接管理（Netty 用 PoolChunkList 池化）。
- **排查**：`-XX:NativeMemoryTracking=detail` + `jcmd <pid> VM.native_memory`。

**⑤ 对象一定分配在堆上吗？** 🔴
- 不一定。JDK6+ 的**逃逸分析**（-XX:+DoEscapeAnalysis，默认开）：
  - **方法逃逸**：对象被方法外引用（返回、赋给全局）→ 必须堆分配。
  - **线程逃逸**：对象被其他线程访问 → 堆分配。
  - **未逃逸**：可**栈上分配**（实际是**标量替换**——把对象拆成基本类型局部变量）。
- 例：方法内 `new Point(1,2)` 只在方法内用，JVM 可能不创建 Point 对象，直接用两个 int 变量。

**⑥ TLAB（Thread Local Allocation Buffer）** 🟡
- 堆是共享的，多线程分配对象要竞争指针（CAS）。Hotspot 在 Eden 区给每个线程划一块 TLAB 私有缓冲区，线程在自己的 TLAB 内分配无锁。
- -XX:+UseTLAB 默认开。TLAB 满才 CAS 申请新 TLAB 或直接 Eden 分配。

---

## 1.2 对象的创建全过程（6 步）🔴

```
┌─────────────────────────────────────────────────────────┐
│ 1. 类加载检查                                            │
│    new → 常量池定位类符号 → 检查是否已加载/解析/初始化      │
│    没有 → 触发类加载（见 1.7）                            │
├─────────────────────────────────────────────────────────┤
│ 2. 分配内存                                              │
│    方式 A：指针碰撞（Bump the Pointer）                   │
│      内存规整（Serial/ParNew）→ 移动指针即可              │
│    方式 B：空闲列表（Free List）                          │
│      内存碎片（CMS）→ 维护空闲块列表，找合适的             │
│    并发安全：CAS 重试 或 TLAB 或加锁                      │
├─────────────────────────────────────────────────────────┤
│ 3. 内存空间初始化为零值（不含对象头）                      │
│    → 保证实例字段无需赋初值就能用（Java 不赋值有默认值）   │
├─────────────────────────────────────────────────────────┤
│ 4. 设置对象头（Object Header）                            │
│    - Mark Word（hashCode/分代年龄/锁状态，32/64 bit）     │
│    - 类型指针（Class Pointer，指向 Class 元数据）         │
│    - 数组长度（仅数组对象有）                             │
├─────────────────────────────────────────────────────────┤
│ 5. 执行 <init>（构造方法）                                │
│    → 调用构造函数，对字段赋初值                           │
├─────────────────────────────────────────────────────────┤
│ 6. 引用指向对象（栈帧局部变量表）                          │
└─────────────────────────────────────────────────────────┘
```

### 对象内存布局（Hotspot）

```
┌──────────────────────────────────────────────┐
│ 对象 = 对象头 + 实例数据 + 对齐填充            │
├──────────────────────────────────────────────┤
│ 对象头 Header：                                │
│   - Mark Word（8 byte，64位）                  │
│   - Class Pointer（4 byte 压缩 / 8 byte）     │
│   - [数组长度 4 byte，仅数组]                  │
│ 实例数据 Instance Data：字段值（按类型宽度排序）│
│ 对齐填充 Padding：补齐 8 byte 整数倍           │
└──────────────────────────────────────────────┘
```

**Mark Word 内容随锁状态变化**（见 3.3 synchronized）：
```
无锁：    hashCode(31) | 分代年龄(4) | 0(1偏向位) | 01(2锁标志)
偏向锁：  线程ID(54) | epoch(2) | 分代年龄(4) | 1 | 01
轻量级锁：指向栈中Lock Record的指针(62) | 00
重量级锁：指向ObjectMonitor的指针(62) | 10
GC标记：  空 | 11
```

---

## 1.3 GC 算法深度对比

| 算法 | 过程 | 优 | 劣 | 适用 |
|------|------|----|----|------|
| 标记-清除 Mark-Sweep | ①从 GC Roots 遍历标记存活 ②清除未标记 | 简单、无移动 | **碎片**、效率不稳（存活多时清除慢）| CMS |
| 复制 Copying | 内存分两块，存活对象复制到另一块 | 无碎片、快（存活少时）| 浪费一半空间 | 新生代 |
| 标记-整理 Mark-Compact | 标记 → 存活对象向一端移动 | 无碎片、不浪费 | 移动成本高、STW 长 | 老年代 |
| 分代收集 Generational | 新生代复制 + 老年代标记整理 | 综合最优 | 实现复杂 | 主流 |

### 🔴 GC Roots（根对象）完整清单

为什么需要 GC Roots？可达性分析从 Roots 出发遍历对象图，不可达的 = 垃圾。

GC Roots 包括：
1. **虚拟机栈**中的引用（方法局部变量、参数、临时变量）——最主要
2. **本地方法栈**中 JNI 引用
3. **方法区**中类静态变量引用
4. **方法区**中常量引用（如字符串常量池里的引用）
5. **JVM 内部引用**：基本类型 Class、常驻异常对象（NullPointerException 等）、系统类加载器
6. **同步锁 synchronized** 持有的对象
7. **JMXBean、JVMTI**（追踪本地代码的对象）
8. **分代回收的"临时 GC Roots"**：跨代引用处理时，老年代作为 Roots 扫描成本高，用 **Remembered Set / Card Table** 记录跨代引用，避免全堆扫描。

### 跨代引用问题（Card Table + Write Barrier）🟡
- 老年代引用新生代 → Minor GC 时本应把整个老年代当 Roots，代价大。
- 解决：**Card Table**（卡表，512B 一张卡）。老年代写引用到新生代时，**写屏障**把对应卡标记为 dirty。Minor GC 只扫 dirty 卡。
- G1 用 **Remembered Set（RSet）**，每个 Region 记录"谁指向我"。

---

## 1.4 垃圾收集器全景（演进 + 对比 + 选型）

```
新生代(复制)         老年代
─────────────────────────────────────────────
Serial    ──────── Serial Old     (单线程，client 模式)
ParNew   ──────── CMS             (标记清除，并发)
Parallel Scavenge ── Parallel Old (吞吐量优先)
          G1                       (Region 化，混合回收)
          ZGC / Shenandoah         (着色指针/读屏障，亚毫秒停顿)
```

### ① CMS（Concurrent Mark Sweep）🔴 必精通（虽已废弃但常考）

**设计目标**：低停顿（并发收集，STW 短）。

**四阶段**：
```
阶段1 初始标记 Initial Mark（STW）
   ↓ 只标记 GC Roots 直接关联的对象，速度极快
阶段2 并发标记 Concurrent Mark
   ↓ 从 Roots 遍历对象图，与用户线程并发（耗时最长但不卡）
阶段3 重新标记 Remark（STW）
   ↓ 修正并发标记期间用户线程导致的标记变化
   ↓ 使用增量更新（Incremental Update）
阶段4 并发清除 Concurrent Sweep
   ↓ 清除未标记对象，与用户线程并发
```

**CMS 的 4 大痛点** 🔴：
1. **CPU 敏感**：并发阶段占工作线程（默认 (CPU+3)/4 个），降低吞吐。
2. **浮动垃圾 Floating Garbage**：并发清除期间新产生的垃圾本轮回收不了。
3. **空间碎片**（标记-清除）→ 大对象分配困难 → 触发 Full GC。
4. **Concurrent Mode Failure**：并发阶段老年代满了 → 退化为 Serial Old（单线程 STW Full GC），停顿极长。

**为什么 JDK9 废弃 CMS？** 碎片化 + 浮动垃圾导致频繁 Full GC，维护成本高，G1 更成熟。

### ② G1（Garbage First）🔴🔴 必精通（JDK9 默认）

**核心思想**：把堆切成 Region，跟踪每个 Region 的回收价值（垃圾占比），**优先回收价值高的**（Garbage First）。

**内存模型**：
```
堆切分为 ~2048 个 Region，每个 1~32MB（2 的幂，自动选）
逻辑分代（不再物理连续）：
  ┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐
  │E │E │S │O │O │H │H │O │E │O │空│空│
  ├──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┤
  E=Eden  S=Survivor  O=Old  H=Humongous(大对象，跨多个 Region)
```
- 一个 Region 当前是什么角色是动态的（回收后可转变）。
- 大对象（>Region 一半）进 Humongous Region。

**关键数据结构**：
- **Remembered Set（RSet）**：每个 Region 一个，记录"哪些其他 Region 引用了我"，避免全堆扫描。**Point-into**（指向自己）。
- **Collection Set（CSet）**：本次回收的 Region 集合。

**回收过程**：
```
【Young GC】（只回收年轻代 Region）
  Eden/Survivor 满 → 触发 → STW → 复制存活到新 Survivor/Old

【并发标记周期 Concurrent Marking Cycle】（Mixed GC 前奏）
  -XX:InitiatingHeapOccupancyPercent（默认 45%）触发
  1. 初始标记（STW，搭车一次 Young GC）
  2. 根区域扫描（扫描 Survivor 指向 Old 的引用）
  3. 并发标记（SATB 快照，三色标记）
  4. 重新标记（STW，处理 SATB 缓冲区）
  5. 清理（STW，统计每个 Region 垃圾占比，选 CSet）

【Mixed GC】（回收所有年轻代 + 部分老年代 Region）
  - 按"垃圾比例 / 预期停顿"选老年代 Region
  - 可通过 -XX:G1MixedGCCountTarget 控制分多次回收完
```

**三色标记 + SATB** 🔴（G1 的并发标记算法）：
```
白色：未访问
灰色：自己访问了，子节点未访问完
黑色：自己+子节点都访问完（安全，不会漏标）

漏标问题：并发标记时，黑色对象新增指向白色对象的引用 → 漏标
CMS 用 增量更新：新增引用时重新标记黑色变灰
G1 用 SATB（Snapshot-At-The-Beginning）：
  开始时拍快照，并发期间删除的引用记到 SATB 缓冲区
  重新标记时把 SATB 中的对象当存活（宁可多标不漏标）
```

**关键参数**：
```bash
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200       # 期望最大停顿（软目标，G1 会努力但不保证）
-XX:G1HeapRegionSize=16m       # Region 大小（不设自动算）
-XX:InitiatingHeapOccupancyPercent=45  # 触发并发标记的堆占用阈值
-XX:G1NewSizePercent=5         # 新生代最小占比
-XX:G1MaxNewSizePercent=60     # 新生代最大占比
-XX:G1MixedGCCountTarget=8     # Mixed GC 分多少次完成
-XX:G1MixedGCLiveThresholdPercent=90  # Region 存活对象超此比例不回收
-XX:+ParallelRefProcEnabled    # 并行处理引用（加速）
```

**G1 触发 Full GC 的场景** 🔴（灾难，要避免）：
1. 并发标记跟不上分配速度（老年代涨太快）。
2. Mixed GC 没回收到足够空间。
3. Evacuation Failure（转移时没足够 Region 放存活对象）。
4. Humongous Allocation 失败。
→ 退化为 **JDK10 前单线程、JDK10+ 多线程**的 Serial Full GC，停顿几秒到几十秒。

**什么时候用 G1？** 堆 >6GB、停顿目标 0.1-0.5s。

### ③ ZGC（Z Garbage Collector）🔴（JDK15 转正）

**目标**：停顿 <1ms（JDK16+），与堆大小无关（TB 级堆也能）。

**两大核心技术**：
1. **着色指针（Colored Pointers）**：
   - 64 位指针的高 4 位塞 GC 元信息：Marked0 / Marked1 / Remapped / Finalizable。
   ```
   64 位指针布局（ZGC）：
   [18未用][1 Finalizable][1 Remapped][1 Marked1][1 Marked0][42 地址]
   ```
   - 指针本身携带状态，GC 时改指针的标志位，无需改对象头。

2. **读屏障（Load Barrier）**：
   - 每次从堆读引用，JVM 插入检查（读屏障）。
   - 若指针颜色不对（过期），**自愈**：把对象转移到新位置，更新指针。
   - 这样 GC 和应用可并发移动对象，几乎无 STW（只初始/重新标记有极短 STW）。

**代价**：吞吐略降（~10%，读屏障开销）。

**适用**：超大堆、低延迟要求极致（金融交易、实时）。

### ④ Shenandoah（RedHat，JDK12+）
- 与 ZGC 类似（亚毫秒停顿），用** Brooks 转发指针**（每个对象多一个指针指向自己或新副本）而非着色指针。
- OpenJDK 自带，Hotspot 用 ZGC 较多。

### 收集器选型决策树 🔴
```
堆 < 4GB？→ Parallel（吞吐优先）或 G1
堆 4-32GB，停顿 200ms 可接受？→ G1（默认）
堆 > 32GB 或停顿 <10ms？→ ZGC
```

---

## 1.5 内存分配策略（对象进新生代还是老年代？）

```
1. 对象优先在 Eden 分配（TLAB）
   Minor GC：Eden 满触发，Eden+S0 存活复制到 S1，年龄+1
2. 大对象直接进老年代（-XX:PretenureSizeThreshold）
   避免在 Eden 和 Survivor 间来回复制
3. 长期存活进老年代（MaxTenuringThreshold，默认 15；CMS 是 6）
4. 动态年龄判断：
   Survivor 中相同年龄对象大小总和 > Survivor 空间的 50%
   → 年龄 >= 该年龄的对象直接进老年代
5. 空间分配担保：
   Minor GC 前检查 老年代连续可用空间 > 新生代所有对象总空间
   不满足 → 检查是否允许担保失败（HandlePromotionFailure）
   允许 → 冒险 Minor GC（可能 Promotion Failed 触发 Full GC）
   不允许 → 直接 Full GC
```

**新生代为什么用复制算法？** 🔴
- 新生代朝生夕死（95%+ 对象很快死），存活少 → 复制成本低。
- 8:1:1 划分，浪费只有 10%（只用一个 Survivor）。

---

## 1.6 类加载机制（详解 + 破坏双亲委派实战）

### 类加载 7 步全过程

```
加载 Loading
  → 通过类全限定名获取字节流（从 jar/网络/动态生成）
  → 转为方法区的运行时数据结构
  → 生成 java.lang.Class 对象（堆中），作为方法区数据入口
    ↓
验证 Verification
  → 文件格式、元数据、字节码、符号引用验证（确保安全合规）
    ↓
准备 Preparation
  → 为类变量（static）分配内存并赋【零值】（int→0, 引用→null）
  → 注意：static final 常量在此阶段赋【初值】（ConstantValue 属性）
    例：static int a = 123;  准备阶段 a=0，初始化阶段 a=123
        static final int A = 123;  准备阶段就 A=123
    ↓
解析 Resolution
  → 符号引用替换为直接引用（方法/字段/类的内存地址）
  → 可在初始化前或延迟到首次使用（延迟解析）
    ↓
初始化 Initialization  ← 真正执行类构造器
  → 执行 <clinit>：所有 static 变量赋值 + static{} 块
  → JVM 保证 <clinit> 线程安全（多线程初始化同一类，只有一个执行，其他阻塞）
    ↓
使用 Using
    ↓
卸载 Unloading
```

**类初始化触发时机（6 种，主动引用）** 🟡：
1. new / getstatic / putstatic / invokestatic（new 对象、读写静态字段、调静态方法）
2. 反射调用（Class.forName）
3. 初始化一个类，父类未初始化则先初始化父类
4. JVM 启动主类（含 main）
5. MethodHandle 句柄对应的类
6. 接口含 default 方法，实现类初始化时接口先初始化

**不触发初始化**：通过子类访问父类静态字段（只初始化父类）；通过数组定义 `MyClass[]`；常量（ConstantValue）。

### 双亲委派模型 + 工作流程

```
         BootstrapClassLoader（启动类加载器，C++，加载 JAVA_HOME/lib）
              ↑ 委派
         ExtClassLoader（扩展类加载器，加载 JAVA_HOME/lib/ext）
              ↑ 委派
         AppClassLoader（应用类加载器，加载 classpath）
              ↑ 委派
         自定义 ClassLoader
```

**委派逻辑**（ClassLoader.loadClass）：
```java
protected Class<?> loadClass(String name, boolean resolve) {
    // 1. 检查是否已加载
    Class<?> c = findLoadedClass(name);
    if (c == null) {
        try {
            // 2. 委派父加载器
            c = parent.loadClass(name, false);
        } catch (ClassNotFoundException e) {
            // 3. 父加载不到，自己 findClass
            c = findClass(name);
        }
    }
    return c;
}
```

**为什么需要双亲委派？** 🔴
1. **安全**：防止核心类被篡改。用户写 `java.lang.String` 会被委派到 Bootstrap 加载真正的 String。
2. **避免重复加载**：保证类的唯一性（同一个类 + 同一个加载器 = 同一个 Class 对象）。

### 破坏双亲委派的 5 大场景 🔴🔴

**场景 1：JDBC（SPI 机制 + TCCL）**
- 问题：`java.sql.DriverManager`（rt.jar，Bootstrap 加载）要加载第三方 `com.mysql.Driver`（classpath，App 加载）。
- Bootstrap 是 App 的"祖父"，无法向下委派。
- 解决：**线程上下文类加载器（TCCL，Thread Context ClassLoader）**。
```java
// DriverManager 内部用 TCCL 加载 Driver
ClassLoader cl = Thread.currentThread().getContextClassLoader(); // AppClassLoader
ServiceLoader<Driver> loaders = ServiceLoader.load(Driver.class, cl); // 反向用 App 加载
```

**场景 2：Tomcat（应用隔离）**
```
Tomcat 类加载结构：
  CommonClassLoader（共享）
    ↑
  CatalinaClassLoader（Tomcat 自身）
    ↑
  SharedClassLoader（多应用共享）
    ↑
  WebAppClassLoader（每个 Web 应用一个）← 打破双亲委派
    ↑
  JspClassLoader（每个 JSP 一个）
```
- WebAppClassLoader **优先自己加载** WEB-INF/classes，再委派父类（与双亲委派相反）。
- 目的：不同 Web 应用可能依赖不同版本的同一 jar，必须隔离。

**场景 3：OSGi / 模块化**
- 网状类加载结构，每个模块独立 ClassLoader，模块间可声明依赖。
- 彻底打破树状双亲委派。

**场景 4：热部署 / 热加载**
- 修改类后，用新 ClassLoader 重新加载 → 新 Class 对象。
- 旧 Class 对象等老实例 GC 后释放。
- OSGi、JRebel、Spring DevTools 用此机制。

**场景 5：SPI（ServiceLoader）**
- 同 JDBC，所有 SPI 都用 TCCL。

---

## 1.7 JVM 调优实战（参数 + 决策 + 案例）

### 常用参数完整版
```bash
# ===== 堆 =====
-Xms4g -Xmx4g               # 初始=最大（生产建议相等，避免扩缩抖动）
-Xmn 或 -XX:NewRatio=2      # 新生代 / 老年代:新生代比例
-XX:SurvivorRatio=8         # Eden:S0:S1 = 8:1:1
-XX:MaxTenuringThreshold=15 # 晋升老年代年龄阈值

# ===== 元空间 =====
-XX:MetaspaceSize=256m      # 触发 Full GC 的阈值（建议设大，避免早期 FullGC）
-XX:MaxMetaspaceSize=512m

# ===== 直接内存 =====
-XX:MaxDirectMemorySize=1g

# ===== 收集器 =====
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:+ParallelRefProcEnabled  # 并行处理 Reference（Finalizer 等）

# ===== GC 日志（JDK9+ 统一日志 Xlog）=====
-Xlog:gc*,gc+heap=debug:file=gc.log:time,uptime,level,tags:filecount=10,filesize=100m

# ===== 故障诊断 =====
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dump/
-XX:OnError="jstack %p"     # 错误时执行
-XX:+PrintCommandLineFlags  # 打印 JVM 启动参数
```

### 调优三大目标（权衡）🔴
```
低延迟（停顿短）↔ 高吞吐（GC 占 CPU 比例低）↔ 不 Full GC
三者要权衡，无法全占。
```
- **低延迟**：G1/ZGC，调小 MaxGCPauseMillis。
- **高吞吐**：Parallel，调大新生代减少 GC 频率。
- **避免 Full GC**：合理堆大小 + 监控。

### 📌 线上实战案例 1：G1 频繁 Mixed GC 导致接口抖动

**现象**：线上订单接口 P99 偶发飙到 3s，每 10 分钟左右一次。
**排查**：
1. Grafana 看 GC：M ixed GC 频繁，每次 800ms，老年代占用 70%。
2. GC 日志看：`InitiatingHeapOccupancyPercent=45` 触发并发标记，但回收效率低（很多 Region 存活对象超 85%）。
3. 堆 dump：发现一个 `Cache` 对象占 2GB（本地缓存没设淘汰）。

**解决**：
- 业务层：缓存加 LRU 淘汰 + 改用 Caffeine（限制大小）。
- JVM：`-XX:InitiatingHeapOccupancyPercent=35`（更早触发标记），`-XX:G1MixedGCLiveThresholdPercent=65`（放宽回收条件）。
- 监控：堆占用告警 60%。

**结果**：Mixed GC 从 10 分钟一次降到 1 小时一次，停顿从 800ms 降到 200ms。

### 📌 线上实战案例 2：Full GC 诡异触发

**现象**：每天凌晨 3 点固定一次 Full GC，停顿 8s。
**排查**：
1. 不是业务高峰，但定时任务（报表生成）在跑。
2. dump 分析：定时任务用 `new HashMap()` 累积了 3 亿条数据（没分页查 DB）。
3. 大对象 + 老年代瞬间涨满 → Full GC。

**解决**：报表改流式处理（MyBatis Cursor + 分批写），避免内存堆积。

**教训**：警惕"大对象/大数据集"进老年代，业务要做分页/流式。

---

## 1.8 线上问题排查 SOP（必背，面试高频）🔴🔴

### SOP 1：CPU 100% 排查（完整 7 步）

```
① top                      找 CPU 最高的进程 PID
② top -Hp <PID>            找进程内 CPU 最高的线程 TID（十进制）
③ printf "%x\n" <TID>      转十六进制（nid）
④ jstack <PID> > stack.log 导出线程栈（建议连导 3 次，间隔 5s）
⑤ grep "nid=<hex>" stack.log  定位代码行
⑥ 分析根因：
   - 死循环 / 无限递归
   - GC 频繁（jstat -gc <PID> 1000 看 FGCT/YGCT）
   - 正则灾难回溯
   - 序列化/反序列化死循环
   - 加密/哈希计算密集
⑦ 修复 + 验证
```

**也要判断是不是 GC 引起**：
- `top` 看进程 CPU 高，但 `top -Hp` 里用户线程都 idle → 多半是 GC 线程（"GC task thread")在烧。
- `jstat -gcutil <PID> 1000 10` 看 GCT 占比 + Full GC 频率。

### SOP 2：OOM 排查（分类 + 工具）

| OOM 类型 | 原因 | 排查 |
|---------|------|------|
| `Java heap space` | 堆溢出：内存泄漏 / 大对象 / 大数据集 | dump + MAT 支配树 |
| `Metaspace` | 动态生成类太多（CGLIB/Groovy/JSP/反射） | 调大 MaxMetaspaceSize + 找类泄漏 |
| `GC overhead limit` | GC 花 >98% 时间回收 <2% 堆 | 实质堆溢出前兆，同上 |
| `Direct buffer memory` | NIO 堆外内存（Netty） | MaxDirectMemorySize + 排查未释放 |
| `unable to create new native thread` | 线程数超限 / 内存不够创建线程栈 | 查线程泄漏 / 调 ulimit -u / 减 -Xss |
| `Requested array size exceeds VM limit` | 申请的数组超 Integer.MAX_VALUE | 业务 bug |

**MAT（Memory Analyzer）分析流程**：
1. `jmap -dump:format=b,file=heap.hprof <PID>`（或自动 dump）。
2. MAT 打开 → **Leak Suspects Report**（自动分析疑似泄漏）。
3. **Dominator Tree**（支配树）：找占内存最大的对象。
4. **Path to GC Roots**：看对象为什么没被回收（被谁持有）。
5. 定位到具体类/集合 → 修代码。

### SOP 3：接口响应慢排查

```
单接口慢 or 全局慢？
全局慢 → 机器资源（CPU/内存/GC/网络/磁盘 IO）
单接口慢 →
  1. 链路追踪（SkyWalking/Zipkin）看每个 Span 耗时
  2. 细查：
     - DB：慢查询日志 + explain（锁等待？大结果集？）
     - 下游接口：超时配置 / 重试风暴
     - Redis：大 Key 阻塞 / 网络抖动
     - GC：Full GC 停顿（看 GC 日志）
     - 锁竞争：jstack 看 BLOCKED 线程
     - 日志：同步写日志阻塞（改异步）
  3. 优化 + 压测验证
```

### 常用诊断工具清单 🔴
| 工具 | 用途 |
|------|------|
| jps | Java 进程列表 |
| jstat | GC/类加载统计（jstat -gc <pid> 1000） |
| jstack | 线程栈（死锁/CPU 高） |
| jmap | 内存快照、直方图（jmap -histo:live） |
| **Arthas** | 在线热诊断神器：dashboard/thread/trace/watch/heapdump |
| MAT | 离线 dump 深度分析 |
| async-profiler | 火焰图，性能剖析 |
| GCEasy/GCViewer | GC 日志分析 |
| JConsole/jvisualvm | 可视化监控 |

**Arthas 高频命令**：
```bash
dashboard            # 总览
thread -n 3          # CPU top3 线程
thread -b            # 找阻塞其他线程的"罪魁"
trace 类 方法        # 方法调用链耗时
watch 类 方法 '{params, returnObj}'  # 查看入参返回
jad 类               # 反编译（确认线上代码版本）
heapdump /tmp/x.hprof
```

---

# 第二篇 并发编程 JUC（讲到 AQS/线程池源码级 + 实战）

## 2.1 并发三要素 & JMM（Java Memory Model）

| 要素 | 问题 | 原因 | 解决 |
|------|------|------|------|
| **可见性** | 线程改了变量，另一个看不到 | CPU 缓存 / 工作内存 | volatile / synchronized / Lock |
| **原子性** | 操作被中断 | 指令非原子 | synchronized / Lock / CAS |
| **有序性** | 指令重排 | 编译器/CPU 优化 | volatile（内存屏障）/ happens-before |

### JMM 模型

```
线程 A                      线程 B
┌──────────┐               ┌──────────┐
│ 工作内存  │               │ 工作内存  │  ← CPU 缓存抽象
│ (本地副本)│               │ (本地副本)│
└────┬─────┘               └────┬─────┘
     │ save/load                 │ save/load
┌────┴──────────────────────────┴────┐
│            主内存（共享变量）          │
└────────────────────────────────────┘
```
- JMM 定义 8 种原子操作：lock/unlock/read/load/use/assign/store/write。
- 线程不能直接操作主内存，必须通过工作内存。

### happens-before 8 大规则 🔴
1. 程序顺序规则（同线程内，代码书写顺序，但有依赖才保证）
2. 监视器锁规则（unlock happens-before 后续 lock）
3. volatile 变量规则（写 happens-before 后续读）
4. 线程启动规则（Thread.start() happens-before 该线程所有动作）
5. 线程终止规则（线程所有动作 happens-before Thread.terminate()）
6. 线程中断规则（interrupt() happens-before 检测到中断）
7. 对象终结规则（构造方法结束 happens-before finalizer）
8. 传递性（A happens-before B，B happens-before C → A happens-before C）

**作用**：判断并发环境下"某次写是否对另一次读可见"。

---

## 2.2 volatile 深度（底层 + 应用）

### 两层语义
1. **可见性**：写 volatile 变量 → 强制刷主内存 + 让其他线程工作内存失效。
2. **禁止指令重排**：插入**内存屏障**。

### 底层实现（汇编级）🔴
- Hotspot 写 volatile 变量 → 生成 `lock addl $0x0, (%rsp)` 指令（lock 前缀）。
- **lock 前缀指令的作用**：
  1. 锁定缓存行 → 触发 **MESI 缓存一致性协议** → 其他 CPU 该缓存行失效。
  2. 作为**全屏障**（StoreLoad），禁止前后指令重排。

### 内存屏障 4 种 🟡
| 屏障 | 作用 |
|------|------|
| LoadLoad | Load1; LoadLoad; Load2 → Load1 必须先于 Load2 |
| StoreStore | Store1; StoreStore; Store2 → Store1 必须先于 Store2 |
| LoadStore | Load; LoadStore; Store → Load 先于 Store |
| StoreLoad | Store; StoreLoad; Load → 最强（全屏障），Store 先于后续 Load |

volatile 写前插 StoreStore，写后插 StoreLoad；读后插 LoadLoad + LoadStore。

### volatile 不保证原子性 🔴
`i++` 是读-改-写三步：
```
1. 读 i 到工作内存
2. i+1
3. 写回主内存
```
volatile 保证每步可见，但**三步之间可被打断** → 丢更新。要 `AtomicInteger`（CAS）或锁。

### 🔴 经典应用：DCL 单例为什么必须 volatile

```java
public class Singleton {
    private static volatile Singleton instance;  // volatile 必加！
    public static Singleton getInstance() {
        if (instance == null) {
            synchronized (Singleton.class) {
                if (instance == null) {
                    instance = new Singleton();
                }
            }
        }
        return instance;
    }
}
```

**`new Singleton()` 编译成 3 步**：
```
① memory = allocate()    // 分配内存
② ctorInstance(memory)   // 初始化对象
③ instance = memory      // 引用指向内存
```
**指令重排可能变 ①③②**：其他线程在 ③ 之后、② 之前判 `instance != null` → 拿到**未初始化对象** → NPE。

volatile 禁止 ②③ 重排，保证安全。

**为什么用双检查（DCL）？**
- 第一次 check：避免每次都加锁（性能）。
- 第二次 check：防止并发下重复创建。

---

## 2.3 synchronized 深度（锁升级源码级）

### 对象头 Mark Word 与锁状态（64 位）🔴🔴

```
┌──────────────────────────────────────────────────────────────┐
│ 锁状态    │ Mark Word 内容（64 bit）              │ 标志位     │
├───────────┼───────────────────────────────────────┼───────────┤
│ 无锁      │ unused(25) | hashCode(31) | unused(1) │ 0 01      │
│           │ | 分代年龄(4) | 0(偏向位) | 01(锁标志) │           │
│ 偏向锁    │ 线程ID(54) | epoch(2) | 分代年龄(4)   │ 1 01      │
│           │ | 1(偏向位) | 01                      │           │
│ 轻量级锁  │ 指向栈中 Lock Record 的指针(62)        │ 00        │
│ 重量级锁  │ 指向 ObjectMonitor 的指针(62)         │ 10        │
│ GC 标记   │ -                                     │ 11        │
└──────────────────────────────────────────────────────────────┘
```

### 锁升级完整流程（JDK6+ 优化）🔴

```
┌─────────┐  多线程竞争   ┌──────────┐  自旋失败    ┌──────────┐
│  无锁    │ ──────────→ │ 偏向锁    │ ──────────→ │ 轻量级锁  │
│ (01,0)  │              │ (01,1)   │              │ (00)     │
└─────────┘              └──────────┘              └────┬─────┘
                                                       │ 竞争激烈
                                                       ▼
                                                  ┌──────────┐
                                                  │ 重量级锁  │
                                                  │ (10)     │
                                                  └──────────┘
特点：只升不降（GC 除外）
```

**① 偏向锁（Biased Locking）**
- 第一个线程进入 → CAS 把自己 ThreadID 写入 Mark Word。
- 之后该线程再进入，只比对 ThreadID（无 CAS 无自旋），近乎无开销。
- 适合**单线程重入**场景。
- **JDK15 废弃**（现代应用竞争多，偏向锁 revocation 成本 > 收益）。

**② 轻量级锁（Thin Lock / 自旋锁）**
- 多线程交替（无真竞争）→ 每个线程栈帧生成 **Lock Record**。
- CAS 把 Mark Word 复制到 Lock Record（Displaced Mark Word），并尝试把 Mark Word 指向 Lock Record。
- 成功 → 获锁。失败 → 自旋（自适应自旋：上次成功就多旋几次）。
- 适合**多线程交替执行，持有时间短**。

**③ 重量级锁（Heavyweight Lock）**
- 自旋失败 → Mark Word 指向 **ObjectMonitor**（C++ 实现）。
- 未获锁线程进入 **EntryList**，调用 `pthread_mutex_lock` 阻塞（OS 调度，成本高：用户态↔内核态切换）。
- 适合**竞争激烈、持有时间长**。

### ObjectMonitor 核心结构 🟡
```cpp
class ObjectMonitor {
    ObjectWaiter * _owner;       // 持有者线程
    ObjectWaiter * _EntryList;   // 阻塞等待的线程队列
    ObjectWaiter * _WaitSet;     // wait() 后的线程集合
    int _count;                  // 重入计数
    ...
}
```
- `wait()` → 释放锁，线程进 WaitSet，等 notify 唤醒回 EntryList。
- `notify()` → 从 WaitSet 移一个到 EntryList。

### synchronized vs ReentrantLock 🔴
| | synchronized | ReentrantLock |
|---|---|---|
| 实现 | JVM 关键字（monitorenter/exit） | AQS（JDK API） |
| 释放 | 自动（出块/异常） | **手动 finally unlock** |
| 中断 | 不可 | lockInterruptibly() |
| 超时 | 不可 | tryLock(timeout) |
| 公平 | 非公平 | 可选公平 |
| 条件变量 | 1 个（wait/notify） | 多个 Condition |
| 锁分离 | 不可 | ReentrantReadWriteLock / StampedLock |

---

## 2.4 CAS 与 ABA（底层 + 自旋）🔴

### CAS（Compare And Swap）
```java
// AtomicInteger.compareAndSet 源码最终调用 Unsafe
public final native boolean compareAndSwapInt(Object o, long offset, int expected, int x);
```
- 硬件支持：x86 的 `cmpxchg` 指令（带 lock 前缀保证总线锁/缓存锁）。
- 原子语义：比较内存值 V 与期望值 E，相等则更新为 N，返回 true；否则返回 false。

### CAS 三大缺点 🔴
1. **自旋开销**：竞争激烈时空转烧 CPU。
2. **只保证一个变量**：多变量要 AtomicReference 包装对象。
3. **ABA 问题**：
   - 值 A→B→A，CAS 认为没变。
   - 解决：**版本号** AtomicStampedReference（值 + stamp 一起比较）。

### ABA 的真实危害场景 🟡
- **栈/链表操作**：线程 1 准备 CAS 把 head 从 A 换成 C，期间线程 2 把 A 弹出又 push 回来（A 的 next 变了），线程 1 CAS 成功但链表结构已破坏。
- **银行转账**：余额 100→200→100，CAS 误判没变（业务上可能有问题）。

### 自适应自旋（Adaptive Spinning）
- JDK6 引入。自旋次数动态调整：上次 CAS 成功 → 认为这次也能成功 → 多旋；反之少旋。
- 避免固定自旋在竞争激烈时空转。

---

## 2.5 AQS（AbstractQueuedSynchronizer）🔴🔴 必精通（源码级）

AQS 是 JUC 的基石：ReentrantLock、Semaphore、CountDownLatch、ReentrantReadWriteLock 都基于它。

### 核心组成

```
              ┌─ volatile int state（同步状态）
AQS ──────────┤
              └─ CLH 队列（变体，FIFO 双向链表，存等待线程的 Node）
```

**state 的含义随实现而异**：
- ReentrantLock：0 无锁，>0 持有次数（可重入）。
- Semaphore：剩余许可数。
- CountDownLatch：未完成的计数。
- ReadWriteLock：高 16 位读 / 低 16 位写。

### CLH 队列结构 🟡
```
       head                                  tail
        ↓                                      ↓
   ┌────────┬──────┬──────┬─────────┬──────┬──────┬────────┐
   │(哨兵)  │ prev │ next │ thread  │waitSt│ next │  ...   │
   │  Node  │←─────│      │─────────│      │─────→│        │
   └────────┴──────┴──────┴─────────┴──────┴──────┴────────┘
   waitStatus: CANCELLED(1) / SIGNAL(-1) / CONDITION(-2) / PROPAGATE(-3)
```

### ReentrantLock 加锁流程（非公平）🔴

```java
// 1. lock()
final void lock() {
    if (compareAndSetState(0, 1)) {          // CAS 抢锁
        setExclusiveOwnerThread(current);    // 设 owner
    } else {
        acquire(1);                          // 抢不到走 AQS 流程
    }
}

// 2. acquire（AQS 模板方法）
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&                  // ① 尝试获锁（子类实现）
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))  // ② 入队+阻塞
        selfInterrupt();                     // ③ 补中断标志
}

// 3. 非公平 tryAcquire（NonfairSync）
final boolean nonfairTryAcquire(int acquires) {
    int c = getState();
    if (c == 0) {                            // 无锁
        if (compareAndSetState(0, acquires)) { // 再次抢
            setExclusiveOwnerThread(current);
            return true;
        }
    } else if (current == getExclusiveOwnerThread()) { // 可重入
        setState(c + acquires);
        return true;
    }
    return false;
}

// 4. acquireQueued：入队后自旋+park
final boolean acquireQueued(Node node, int arg) {
    for (;;) {
        Node p = node.predecessor();
        if (p == head && tryAcquire(arg)) {  // 前驱是 head 才尝试
            setHead(node);
            return;
        }
        if (shouldParkAfterFailedAcquire(p, node) && // 前驱设 SIGNAL
            parkAndCheckInterrupt())                  // LockSupport.park 阻塞
            throw new InterruptedException();
    }
}
```

**公平 vs 非公平区别**：
```java
// 公平锁 tryAcquire 多一步：
if (c == 0) {
    if (!hasQueuedPredecessors() &&   // ← 队列有人等，就不抢
        compareAndSetState(0, acquires)) { ... }
}
```
- 非公平：上来直接 CAS 抢，吞吐高（减少线程切换）。
- 公平：按队列顺序，饿不死，但吞吐低。

### 基于 AQS 的核心组件 🔴
| 组件 | 模式 | state 含义 |
|------|------|-----------|
| ReentrantLock | 独占 | 重入次数 |
| ReentrantReadWriteLock | 共享(读)+独占(写) | 高16读/低16写 |
| Semaphore | 共享 | 许可数 |
| CountDownLatch | 共享 | 计数（到0唤醒） |
| CyclicBarrier | 基于 ReentrantLock+Condition | — |
| StampedLock（JDK8） | 乐观读+写 | 不基于 AQS |

### CountDownLatch vs CyclicBarrier 🔴
| | CountDownLatch | CyclicBarrier |
|---|---|---|
| 实现 | AQS 共享 | ReentrantLock + Condition |
| 计数 | 减到 0 | 达到指定数 |
| 复用 | 一次性 | reset 可复用 |
| 场景 | 主线程等 N 个任务 | N 个线程互相等齐 |

---

## 2.6 线程池（ThreadPoolExecutor）🔴🔴 必精通（源码 + 实战）

### 7 参数 + 状态机

```java
new ThreadPoolExecutor(
    int corePoolSize,                  // 核心线程数
    int maximumPoolSize,               // 最大线程数
    long keepAliveTime, TimeUnit unit, // 非核心线程空闲存活时间
    BlockingQueue<Runnable> workQueue, // 任务队列
    ThreadFactory threadFactory,       // 线程工厂（务必命名！）
    RejectedExecutionHandler handler   // 拒绝策略
);
```

**线程池状态**（ctl 高 3 位存状态，低 29 位存 worker 数）：
```
RUNNING     (-1)  接受新任务 + 处理队列
SHUTDOWN    (0)   不接受新任务 + 处理完队列
STOP        (1)   不接受 + 不处理 + 中断进行中
TIDYING     (2)   所有任务终止，worker 数 0，调 terminated()
TERMINATED  (3)   terminated() 执行完
```

### 执行流程（必背）🔴

```
提交任务 execute(task)
      │
      ▼
┌──────────────────────┐
│ 当前线程数 < core？   │──是──→ 创建核心线程执行
└──────┬───────────────┘
       │否
       ▼
┌──────────────────────┐
│ 队列未满？            │──是──→ 入队等待
└──────┬───────────────┘
       │否
       ▼
┌──────────────────────┐
│ 当前线程数 < max？    │──是──→ 创建非核心线程执行
└──────┬───────────────┘
       │否
       ▼
   执行拒绝策略
```

### 4 种拒绝策略 🔴
1. **AbortPolicy**（默认）：抛 RejectedExecutionException。
2. **CallerRunsPolicy**：让提交任务的线程自己执行（**背压**降速，生产推荐）。
3. **DiscardPolicy**：默默丢弃（慎用，丢数据无感知）。
4. **DiscardOldestPolicy**：丢队列最老的，重试（适合时效性任务）。

### Worker 源码核心 🟡
```java
final void runWorker(Worker w) {
    Runnable task = w.firstTask;
    while (task != null || (task = getTask()) != null) {  // 循环取任务
        w.lock();  // Worker 继承 AQS，独占锁（区分运行/空闲）
        try {
            beforeExecute(w.thread, task);  // 钩子
            task.run();                      // 执行
            afterExecute(task, null);        // 钩子
        } finally {
            task = null;
        }
    }
}
// getTask() 从队列 take/poll，超时返回 null → 线程退出（销毁非核心线程）
```

### 为什么禁用 Executors？🔴
| Executors 方法 | 问题 |
|---------------|------|
| newFixedThreadPool | LinkedBlockingQueue **无界** → 队列堆积 OOM |
| newSingleThreadExecutor | 同上无界队列 |
| newCachedThreadPool | 最大线程 Integer.MAX_VALUE → 线程数 OOM |
| newScheduledThreadPool | DelayedQueue 无界 → OOM |

阿里规约：用 `new ThreadPoolExecutor(...)` 显式有界队列 + 明确参数。

### 线程数怎么设？🔴
- **CPU 密集型**：`N + 1`（N = CPU 核数）。多 1 防偶发停顿。
- **IO 密集型**：`2N` 或 `N × (1 + 等待时间/计算时间)`。
  - 本质：让 CPU 不闲着（IO 时切换其他线程）。
- **混合型**：拆成两个线程池，或根据 Profiling 算。
- **最终靠压测**：监控队列堆积、拒绝次数、活跃线程。

### 📌 线上实战案例 3：线程池把 DB 连接打满

**现象**：订单服务 DB 连接池报满，接口超时。
**排查**：
1. DB 端看连接数：1000+（连接池配 50，怎么这么多）。
2. 查应用：发现有个 `@Async` 异步任务用 `Executors.newFixedThreadPool(200)`，并发查 DB。
3. 200 线程 × 各自拿连接 → 远超连接池。

**解决**：
- 异步线程池调到合理大小（按 DB 连接池反算）。
- 异步任务加 Sentinel 限流。
- 连接池监控告警。

**教训**：线程池大小要和下游资源（DB 连接、HTTP 连接）匹配，不能盲目开大。

### 📌 线上实战案例 4：线程池任务丢失

**现象**：用户提交任务后偶尔不执行，无报错。
**排查**：用 `DiscardPolicy`（默默丢）+ 队列无界（其实有界 1000）但突发流量超 1000 → 丢弃无感知。
**解决**：改 `CallerRunsPolicy`（背压）+ 监控拒绝次数 + 告警。

---

## 2.7 ThreadLocal 深度（原理 + 泄漏 + 最佳实践）🔴

### 数据结构
```
Thread
  └── ThreadLocal.ThreadLocalMap threadLocals
        └── Entry[] table
              Entry extends WeakReference<ThreadLocal<?>>
              {
                  ThreadLocal<?> key;   // 弱引用
                  Object value;         // 强引用
              }
```

### 为什么 key 用弱引用？🔴
- 如果 key 强引用 ThreadLocal，ThreadLocal 对象永远回收不了（只要线程活着）。
- 弱引用让 ThreadLocal 在无强引用时被 GC（key 变 null），但 **value 还在**（强引用）→ 泄漏隐患。

### 内存泄漏机制 🔴

```
Thread (线程池，长期存活)
  └── ThreadLocalMap
        └── Entry[0]: key=WeakRef[ThreadLocal@xxx]  ← GC 后 key=null
                       value=BigObject            ← 强引用，回收不掉！
```
- 线程池场景，线程长期存活。
- ThreadLocal 用完没 remove → key 被 GC 变 null，value 强引用驻留 → 泄漏。

### ThreadLocal 的自清理机制（不够可靠）🟡
- get/set/remove 时会清理 key==null 的 Entry（expungeStaleEntry）。
- **但**：如果不再次访问该 ThreadLocal，value 永远清不掉。

### 最佳实践
```java
ThreadLocal<User> ctx = new ThreadLocal<>();
try {
    ctx.set(user);
    // 业务
} finally {
    ctx.remove();  // 必须手动 remove！尤其线程池场景
}
```

### InheritableThreadLocal 的局限 + TTL 🔴
- InheritableThreadLocal：子线程能继承父线程值，但**线程池失效**（线程复用，父子关系只在线程创建时建立一次）。
- 解决：阿里 **TransmittableThreadLocal（TTL）**，用 Agent 字节码增强 / 装饰 Runnable，在任务提交时快照、执行时回放。
- 场景：链路追踪 traceId、用户上下文、日志 MDC 跨线程池传递。

---

## 2.8 并发容器深度

### ConcurrentHashMap JDK7 vs JDK8 🔴🔴

**JDK7：Segment 分段锁**
```
ConcurrentHashMap
  └── Segment[]（默认 16 段）
        └── HashEntry[]（每段一个数组）
              └── 链表
每个 Segment 继承 ReentrantLock → 锁一段 → 并发度 16
```

**JDK8：Node[] + CAS + synchronized**
```
ConcurrentHashMap
  └── Node[] table
        └── 链表 / TreeBin（红黑树）

put 流程：
1. hash 定位桶
2. 桶空 → CAS 插入（无锁）
3. 桶非空 → synchronized 锁头节点 → 插入（锁粒度=桶）
4. 链表 ≥8 且数组 ≥64 → 转红黑树
5. addCount（baseCount CAS + CounterCell[] 分段计数）
```

**为什么放弃分段锁？** 🔴
1. **并发度更高**：JDK7 上限 16，JDK8 锁粒度到桶，并发度 = 桶数（默认 16，扩容后更多）。
2. **内存更省**：分段锁每段自带锁对象，开销大。
3. **CAS + synchronized 优化**：synchronized 在 JDK6 后优化好（偏向/轻量），空桶 CAS 无锁，冲突才 synchronized。

**size 怎么算？**（借鉴 LongAdder）
- `baseCount`（无竞争时 CAS）+ `CounterCell[]`（有竞争时分段累加）。
- size 时求和，**弱一致性**（可能不准）。

### CopyOnWriteArrayList 🟡
- 写时复制：`ReentrantLock` + 复制新数组 → 旧引用指向新数组。
- 读无锁，读的是旧数组快照（**最终一致**）。
- 适合**读多写少**（监听器列表、配置）。
- 缺点：写放大（每次复制整个数组）、弱一致性。

### 阻塞队列 BlockingQueue（线程池用）
| 实现 | 特点 |
|------|------|
| ArrayBlockingQueue | 有界数组，一把锁（出入互斥） |
| LinkedBlockingQueue | 链表，两把锁（出入分离），默认 Integer.MAX_VALUE（坑） |
| SynchronousQueue | 无容量，直接交付（CachedThreadPool 用） |
| PriorityBlockingQueue | 优先级（堆），无界 |
| DelayQueue | 延时（ScheduledThreadPool 用） |
| LinkedTransferQueue | transfer() 直接交付，高吞吐 |

---

# 第三篇 集合框架（源码级）

## 3.1 HashMap JDK8 源码深度 🔴🔴

### 数据结构
```
table[] (Node / TreeNode)
  [0] → null
  [1] → Node → Node → Node → ... (链表)
  [2] → TreeNode（红黑树）
  ...

Node { int hash; K key; V value; Node next; }
TreeNode extends Node { parent, left, right, prev, red; }
```

### 核心参数
```java
static final int DEFAULT_INITIAL_CAPACITY = 16;
static final float DEFAULT_LOAD_FACTOR = 0.75f;
static final int TREEIFY_THRESHOLD = 8;       // 链表转树
static final int UNTREEIFY_THRESHOLD = 6;     // 树退化链表
static final int MIN_TREEIFY_CAPACITY = 64;   // 树化要求数组长度
```

### hash 扰动函数 🔴
```java
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```
- **高 16 位异或低 16 位**，让高位也参与桶定位。
- 原因：桶下标 `(n-1) & hash`，n 通常小（如 16），只用低几位，碰撞多。扰动让高位也影响。

### 桶下标计算 🔴
```java
index = (n - 1) & hash;  // n 是 2 的幂，等价 hash % n 但更快
```
**为什么容量是 2 的幂？**
- `(n-1) & hash` 等价 `hash % n`，但位运算快。
- 扩容时，元素新位置要么 `原 idx`，要么 `idx + oldCap`（看 hash 新增高位 bit），高效迁移。

### put 流程源码 🔴
```java
final V putVal(int hash, K key, V value, boolean onlyIfAbsent, boolean evict) {
    Node<K,V>[] tab = table;
    // 1. 初始化或扩容
    if (tab == null || tab.length == 0)
        tab = resize();
    int i = (n - 1) & hash;       // 桶下标
    Node<K,V> p = tab[i];
    // 2. 桶空，直接放
    if (p == null)
        tab[i] = newNode(hash, key, value, null);
    else {
        // 3. 桶非空
        Node<K,V> e; K k;
        if (p.hash == hash && ((k = p.key) == key || (key != null && key.equals(k))))
            e = p;                          // 3.1 key 相等，覆盖
        else if (p instanceof TreeNode)
            e = ((TreeNode<K,V>)p).putTreeVal(this, tab, i, hash, key, value); // 3.2 红黑树
        else {
            for (int binCount = 0; ; ++binCount) {  // 3.3 链表遍历
                if ((e = p.next) == null) {          // 尾插
                    p.next = newNode(hash, key, value, null);
                    if (binCount >= TREEIFY_THRESHOLD - 1)
                        treeifyBin(tab, hash);       // 链表≥8 尝试树化
                    break;
                }
                if (e.hash == hash && ((k = e.key) == key || (key != null && key.equals(k))))
                    break;                           // 找到 key
                p = e;
            }
        }
        if (e != null) {  // 覆盖旧值
            V oldValue = e.value;
            if (!onlyIfAbsent || oldValue == null)
                e.value = value;
            return oldValue;
        }
    }
    ++modCount;
    if (++size > threshold)  // 4. 超阈值扩容
        resize();
    return null;
}
```

### 为什么链表转树阈值是 8？🔴
- 理想 hash 下，桶内元素数服从**泊松分布**（λ=0.5）。
- 长度 8 的概率 ≈ 0.00000006，属"极端异常"（hash 退化或恶意攻击）。
- 平时几乎不树化（树化开销大）。
- 退化阈值 6（不是 7，避免 7-8 来回抖动）。

### JDK7 多线程死循环（头插法）🔴🔴
```
JDK7 扩容时 transfer，头插法迁移链表：
原链表：A → B → null
线程1 扩容，处理到 A（记下 next=B）
线程2 扩容完成，B → A（头插反转）
线程1 继续，A.next=B → 把 B 接到新表头 → B.next=A → 环！
→ get 遍历到环 → CPU 100%
```
JDK8 改尾插（保持原顺序），不成环，但**仍非线程安全**（并发 put 丢数据、size 不准）。

### resize 扩容优化（JDK8）🔴
- 扩容 2 倍。
- 元素重新定位：`newIndex = (hash & oldCap) == 0 ? oldIndex : oldIndex + oldCap`。
- 不用重算 hash，只看新增高位 bit。

---

## 3.2 ConcurrentHashMap put 流程（JDK8）🔴

```java
final V putVal(K key, V value, boolean onlyIfAbsent) {
    int hash = spread(key.hashCode());
    for (Node<K,V>[] tab = table;;) {
        int i = (n - 1) & hash;
        Node<K,V> f = tab[i];
        if (f == null) {
            // 桶空 → CAS 无锁插入
            if (casTabAt(tab, i, null, new Node<>(hash, key, value, null)))
                break;
        } else if ((fh = f.hash) == MOVED) {
            // hash==MOVED 表示正在扩容，帮忙迁移
            tab = helpTransfer(tab, f);
        } else {
            // 桶非空 → synchronized 锁头节点
            synchronized (f) {
                if (tabAt(tab, i) == f) {  // 二次确认
                    // 链表/红黑树插入...
                }
            }
        }
    }
    addCount(1L, binCount);  // 分段计数（baseCount + CounterCell）
}
```

---

## 3.3 ArrayList / LinkedList 对比

| | ArrayList | LinkedList |
|---|-----------|------------|
| 底层 | 数组 | 双向链表 |
| 随机访问 | O(1) | O(n) |
| 尾部增 | O(1) 均摊 | O(1) |
| 中间增删 | O(n)（搬移） | O(1)（已定位节点，但定位 O(n)） |
| 内存 | 紧凑 | 每节点多 prev/next 指针 |

**ArrayList 扩容**：首次 10，之后 `oldCap + (oldCap >> 1)` = 1.5 倍（`Arrays.copyOf`）。

**为什么 99% 用 ArrayList？** 🔴
- 数组**缓存友好**（连续内存，CPU 预取），实际性能远好于链表。
- LinkedList 增删优势在"已持有节点引用"时才体现，业务场景几乎不存在（都是先 get(i) 定位再增删，get 本身 O(n)）。
- LinkedList 实现了 Deque，可做队列/栈（但 ArrayDeque 更快）。

---

## 3.4 TreeMap / LinkedHashMap

- **TreeMap**：红黑树，key 有序（Comparable/Comparator），O(log n)。需排序遍历时用。
- **LinkedHashMap**：HashMap + 双向链表，维护**插入顺序**或**访问顺序**（accessOrder=true）。
  - **LRU 经典实现**：accessOrder=true + 重写 removeEldestEntry。
  ```java
  class LRU<K,V> extends LinkedHashMap<K,V> {
      private final int cap;
      LRU(int cap) { super(cap, 0.75f, true); this.cap = cap; }  // accessOrder=true
      @Override
      protected boolean removeEldestEntry(Map.Entry<K,V> eldest) {
          return size() > cap;  // 超容量淘汰最久未访问
      }
  }
  ```

---

# 第四篇 IO / NIO / 零拷贝

## 4.1 BIO → NIO → AIO

| | BIO | NIO | AIO |
|---|-----|-----|-----|
| 模型 | 同步阻塞 | 同步非阻塞（多路复用） | 异步非阻塞 |
| 实现 | InputStream/OutputStream | Channel + Selector + Buffer | CompletionHandler |
| 适用 | 连接少 | 连接多（Netty） | 连接多且数据量大 |

## 4.2 NIO 三大核心 🟡

### Buffer
```
position（当前位置）→ limit（限制）→ capacity（容量）
写模式：position 从 0 增，limit=capacity
flip() 切读：limit=position, position=0
```

### Channel（双向）
FileChannel / SocketChannel / ServerSocketChannel / DatagramChannel。

### Selector（多路复用）
```java
Selector selector = Selector.open();
channel.configureBlocking(false);
channel.register(selector, SelectionKey.OP_READ);
while (true) {
    selector.select();  // 阻塞到有事件
    Set<SelectionKey> keys = selector.selectedKeys();
    for (key : keys) {
        if (key.isReadable()) { /* 读 */ }
    }
}
```
- Linux 基于 **epoll**（epoll_wait），O(1) 事件通知。
- 一个线程管几万连接（Netty 用此）。

## 4.3 零拷贝（Zero-Copy）🔴🔴

### 传统读文件发网络（4 次拷贝 + 4 次上下文切换）
```
1. read(): 磁盘 → 内核读缓冲（DMA）→ 用户空间 buffer（CPU 拷贝）
2. write(): 用户 buffer → 内核 socket 缓冲（CPU）→ 网卡（DMA）
上下文切换：user→kernel→user→kernel→user
```

### mmap（内存映射）
```
mmap() 把文件映射到用户空间内存（与内核共享）
读文件：用户直接读映射内存（无需内核→用户拷贝）
省去一次 CPU 拷贝
```

### sendfile（Linux 2.1+）
```
sendfile() 内核直接从读缓冲 → socket 缓冲 → 网卡
全程不进用户空间
Linux 2.4+ 配合 DMA gather，连 socket 缓冲都省（只传描述符）
2 次拷贝（都是 DMA）
```

### 应用场景 🔴
- **Kafka**：用 sendfile 顺序读 + PageCache，超高吞吐。
- **Netty**：FileRegion 用 sendfile；用 DirectByteBuffer 减一次拷贝。
- **Nginx**：sendfile 默认开。

---

# 第五篇 Java 新特性（高频加分）

## 5.1 各版本重要特性

| 版本 | 重要特性 |
|------|---------|
| Java 8 | Lambda、Stream、Optional、default/static 方法、新日期（java.time） |
| Java 9 | 模块化 Jigsaw、JShell、private 接口方法 |
| Java 11 (LTS) | var 局部推断、HTTP Client、ZGC 实验 |
| Java 17 (LTS) | Sealed 类、Pattern Matching、Record、Switch 表达式 |
| Java 21 (LTS) | **虚拟线程**、Pattern Matching for switch、Record Patterns |

## 5.2 虚拟线程（Virtual Thread，JDK21）🔴 重点

```java
Thread.startVirtualThread(() -> { /* task */ });

// 或线程池
Executors.newVirtualThreadPerTaskExecutor();
```

### 原理
- 由 JVM 调度（非 OS），运行在少量**载体线程（Carrier Thread，ForkJoinPool）**上。
- 虚拟线程在 IO 阻塞时**让出载体线程**（unmount），IO 完成后再 mount 回来。
- 一个应用可起**百万级**虚拟线程。

### 适用与注意 🔴
- **适用**：高并发 IO 密集（HTTP 服务、DB 查询），同步代码写出异步性能（无 callback 地狱）。
- **不适用**：CPU 密集（无收益）、synchronized 长时间持锁（JDK21 会"钉住"载体线程，建议用 ReentrantLock）。
- 与平台线程 API 兼容，ThreadLocal/InheritableThreadLocal 可用（但有性能注意）。

---

# 高频追问清单（自测，盖住回答）

1. 描述一次对象从创建到被回收的完整过程。🔴
2. 元空间替代永久代的原因？🔴
3. 对象一定分配在堆上吗？逃逸分析、标量替换？🔴
4. G1 的 Region、RSet、Mixed GC 流程？什么时候触发 Full GC？🔴🔴
5. G1 的三色标记 + SATB？和 CMS 增量更新的区别？🔴
6. ZGC 为什么能 <1ms 停顿？着色指针 + 读屏障？🔴
7. volatile 底层？为什么 DCL 必须加？🔴
8. synchronized 锁升级全过程？Mark Word 变化？🔴🔴
9. CAS 原理、缺点、ABA？🔴
10. AQS 原理 + ReentrantLock 加锁源码流程？公平非公平区别？🔴🔴
11. 线程池 7 参数 + 流程 + 状态机？为什么禁 Executors？线程数怎么设？🔴🔴
12. ThreadLocal 泄漏机制？为什么 key 弱引用？TTL 解决什么？🔴
13. HashMap put 源码？为什么阈值 8？JDK7 死循环？JDK8 resize 优化？🔴🔴
14. ConcurrentHashMap JDK7 vs JDK8？为什么放弃分段锁？🔴
15. 零拷贝（mmap/sendfile）？Kafka 为什么快？🔴
16. 虚拟线程原理？适用场景？什么情况钉住载体线程？🔴
17. 双亲委派？破坏场景（JDBC/Tomcat/热部署）？🔴

> 对应面试题：`面试/面试题-Java核心.md` 和 `面试/面试题-并发与JVM.md`
