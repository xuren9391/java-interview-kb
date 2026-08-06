# Spring 生态与微服务（源码级 · 三级缓存推导 · 自动配置 · 实战案例）

> 难度：🟢必会 🟡进阶 🔴高阶
> **目标：从"会用"讲到"读得懂源码 + 讲得清设计动机 + 踩过坑"**。
> Spring 原理题（IoC/AOP/循环依赖/事务/自动配置）是面试最高频区之一。
>
> **精讲规范（每个知识点 5 维度）**：
> 1. 为什么 / 痛点分析
> 2. 原理图解 + 代码 / 配置
> 3. 真实案例（优先茶饮 SaaS 场景）
> 4. 对比 / 边界
> 5. 面试话术（30-60 秒，8 年工程师视角）

---

# 第一篇 Spring 核心

## 1.1 IoC / DI 深度

### 为什么 / 痛点分析 🔴

**传统new方式的痛点**：
- **强耦合**：`OrderService` 里 `new MySQLDao()`，换 Oracle 要改业务代码。
- **生命周期失控**：对象自己 new、自己管销毁，连接池、缓存、事务无法统一。
- **测试困难**：单测里没法 mock `new` 出来的真实 DAO。
- **重复创建**：到处 new，本该单例的对象被反复实例化。

**IoC 解决的本质**：把"对象创建 + 依赖装配"的控制权，从**业务代码**反转到**容器**。容器像工厂，业务只声明"我需要什么"（@Autowired），容器负责"造什么、怎么造、什么时候造、造完做什么增强"。

- **IoC（Inversion of Control）**：控制反转，是一种思想（控制权转移）。
- **DI（Dependency Injection）**：IoC 的具体实现方式——容器**主动**把依赖注入对象（setter/构造器/字段）。
- 好处：解耦、便于测试（mock）、便于替换实现、生命周期统一管理、AOP 切面统一增强。

### 原理图解 + 代码

**装配方式演进**：
```
XML 装配（古老）→ 注解装配（@Component/@Autowired）→ Java Config（@Configuration/@Bean）→ 自动装配（SpringBoot @Conditional）
```

**容器核心接口层级**：
```
BeanFactory（顶层，延迟加载，最简）
   └─ ApplicationContext（容器，预加载 + 国际化 + 事件）
         ├─ ClassPathXmlApplicationContext（XML 时代）
         ├─ AnnotationConfigApplicationContext（注解时代）
         └─ AnnotationConfigServletWebServerApplicationContext（SpringBoot Web）
```

**三种注入方式对比**：
```java
// 1. 构造器注入（Spring 官方推荐，不可变、强制依赖、易测）
@Service
public class OrderService {
    private final OrderRepo repo;
    public OrderService(OrderRepo repo) { this.repo = repo; }  // final 保证不可变
}

// 2. setter 注入（可选依赖，可重新注入，解决循环依赖更友好）
@Service
public class OrderService {
    private OrderRepo repo;
    @Autowired
    public void setRepo(OrderRepo repo) { this.repo = repo; }
}

// 3. 字段注入（最简洁，但不推荐：无法 final、难单测、隐藏依赖）
@Service
public class OrderService {
    @Autowired
    private OrderRepo repo;  // 不推荐生产
}
```

### @Autowired vs @Resource vs @Inject 🔴

| 注解 | 来源 | 匹配顺序 |能否配合 @Primary|
|------|------|---------|---|
| @Autowired | Spring | **按类型**，多个时按字段名/参数名 + @Qualifier |是|
| @Resource | JSR250（标准） | **按名字**（name 属性），找不到再按类型 |否（自己有 name）|
| @Inject | JSR330（标准） | 按类型，类似 @Autowired |是|

**@Autowired 多实现的选择规则**：
1. 候选中找 @Primary。
2. 字段名/参数名匹配 Bean 名（按名称兜底）。
3. @Qualifier 指定。
4. 都不行 → NoUniqueBeanDefinitionException。

### @Autowired 的底层：AutowiredAnnotationBeanPostProcessor 🔴

- Spring 启动时注册此 BeanPostProcessor（在 refresh 第 6 步 `registerBeanPostProcessors`）。
- 在 `postProcessProperties` 阶段，扫描 @Autowired/@Value 字段，调用 `beanFactory.resolveDependency` 注入。

```java
// 简化版 AutowiredAnnotationBeanPostProcessor.postProcessProperties
public PropertyValues postProcessProperties(PropertyValues pvs, Object bean, String beanName) {
    InjectionMetadata metadata = findAutowiringMetadata(beanName, bean.getClass(), pvs);
    metadata.inject(bean, beanName, pvs);  // 反射 field.set(bean, resolvedValue)
    return pvs;
}
```

### 真实案例（茶饮 SaaS 场景

前司点单业务有多种支付渠道（微信、支付宝、会员储值、礼品卡），用接口 + @Qualifier + 策略模式：
```java
public interface PayChannel { void pay(Order order); }

@Service("wechatPay")
public class WechatPayChannel implements PayChannel { ... }

@Service
public class PayService {
    private final Map<String, PayChannel> channels;  // Spring 自动按 Bean 名注入 Map
    public PayService(Map<String, PayChannel> channels) { this.channels = channels; }

    public void pay(Order order, String channel) {
        channels.get(channel).pay(order);  // 按支付方式动态分发
    }
}
```
Spring 的容器让"加一种支付方式"= 加一个 @Service，业务代码零修改（开闭原则）。

### 对比 / 边界

| 维度 | new | 工厂模式 | IoC 容器 |
|------|-----|---------|---------|
| 解耦 | 差 | 中 | 强 |
| 生命周期 | 手动 | 手动 | 容器统一 |
| 切面增强 | 无 | 无 | AOP 代理 |
| 测试 mock | 难 | 中 | 容易 |

**适用边界**：IoC 适合**应用内**的对象管理；DTO/VO/PO 等纯数据对象不该交给容器（new 即可）；第三方框架内部对象（如线程池 Worker）由框架自管。

### 面试话术

「IoC 是控制反转的思想，把对象创建和依赖装配的控制权从业务代码转到容器。DI 是它的实现，由容器主动注入依赖。我用得最多的是构造器注入——不可变、好测试，Spring 官方也推荐。底层核心是 BeanFactory，注解注入靠 AutowiredAnnotationBeanPostProcessor 在 postProcessProperties 阶段反射 set 字段。在我们前司点单里，多种支付渠道用 Map<String,PayChannel> 注入实现策略分发，加一种支付就是加个 @Service，符合开闭原则。」

---

## 1.2 Bean 生命周期（源码级 + 完整 9 步）🔴🔴

### 为什么 / 痛点分析

**痛点**：对象从"创建→初始化→使用→销毁"每个阶段都可能需要扩展（注入完依赖后要校验、初始化时要建连接池、AOP 增强要包代理、销毁时要释放资源）。如果让容器硬编码这些逻辑，框架就僵死了。

**设计**：Spring 把生命周期切成 9 步，并在关键节点暴露 **BeanPostProcessor（BPP）扩展点**，让任何扩展（@Autowired、@PostConstruct、AOP、@ConfigurationProperties）都以插件形式插入，框架核心不变。这是**模板方法 + 责任链**的经典应用。

### 完整流程图

```
┌────────────────────────────────────────────────────────────────┐
│ 1. 实例化 Instantiation                                         │
│    createBeanInstance → 调构造方法（或 Supplier/工厂方法）        │
│    【此时对象有了，属性都是默认值】                                │
│    ★ 循环依赖在此处把 ObjectFactory 放入第三级缓存                │
├────────────────────────────────────────────────────────────────┤
│ 2. 属性赋值 Populate                                            │
│    populateBean → @Autowired/@Value 注入依赖                     │
├────────────────────────────────────────────────────────────────┤
│ 3. Aware 回调                                                   │
│    BeanNameAware.setBeanName                                    │
│    BeanFactoryAware.setBeanFactory                              │
│    ApplicationContextAware.setApplicationContext（通过           │
│    ApplicationContextAwareProcessor）                            │
├────────────────────────────────────────────────────────────────┤
│ 4. 前置处理 BeanPostProcessor.postProcessBeforeInitialization   │
│    ★ @PostConstruct 在此触发（CommonAnnotationBeanPP）          │
├────────────────────────────────────────────────────────────────┤
│ 5. 初始化                                                       │
│    InitializingBean.afterPropertiesSet                          │
│    → 自定义 init-method                                         │
├────────────────────────────────────────────────────────────────┤
│ 6. 后置处理 BeanPostProcessor.postProcessAfterInitialization    │
│    ★ AOP 代理在这里生成（AbstractAutoProxyCreator）             │
├────────────────────────────────────────────────────────────────┤
│ 7. 使用 Bean                                                    │
├────────────────────────────────────────────────────────────────┤
│ 8. 销毁前 DestructionAwareBeanPP.postProcessBeforeDestruction   │
│    ★ @PreDestroy 在此触发                                       │
├────────────────────────────────────────────────────────────────┤
│ 9. 销毁                                                        │
│    DisposableBean.destroy                                       │
│    → 自定义 destroy-method                                      │
└────────────────────────────────────────────────────────────────┘
```

**记忆口诀**：实例化 → 属性赋值 → Aware → BPP前置 → 初始化 → BPP后置 → 使用 → 销毁前 → 销毁。
**关键三阶段**：创建（1-3）→ 初始化（4-6，BPP 主战场）→ 销毁（8-9）。

### 核心源码入口（AbstractAutowireCapableBeanFactory.doCreateBean）🟡
```java
protected Object doCreateBean(...) {
    // 1. 实例化
    BeanWrapper instanceWrapper = createBeanInstance(beanName, mbd, args);
    Object bean = instanceWrapper.getWrappedInstance();

    // ★ 提前暴露 ObjectFactory（循环依赖用，三级缓存）
    boolean earlySingletonExposure = (mbd.isSingleton() && this.allowCircularReferences &&
            isSingletonCurrentlyInCreation(beanName));
    if (earlySingletonExposure) {
        addSingletonFactory(beanName, () -> getEarlyBeanReference(beanName, mbd, bean));
    }

    // 2. 属性赋值
    populateBean(beanName, mbd, instanceWrapper);
    // 3-6. 初始化（Aware + BPP before + init + BPP after）
    exposedObject = initializeBean(beanName, exposedObject, mbd);
    return exposedObject;
}

protected Object initializeBean(String beanName, Object bean, RootBeanDefinition mbd) {
    invokeAwareMethods(beanName, bean);                          // 3. Aware
    wrappedBean = applyBeanPostProcessorsBeforeInitialization(wrappedBean, beanName);  // 4. BPP before
    invokeInitMethods(beanName, wrappedBean, mbd);               // 5. init
    wrappedBean = applyBeanPostProcessorsAfterInitialization(wrappedBean, beanName);   // 6. BPP after
    return wrappedBean;
}
```

### 关键点 🔴
- **AOP 代理在 `postProcessAfterInitialization`（第 6 步）生成**（AbstractAutoProxyCreator.postProcessAfterInitialization）。
- **循环依赖的特殊路径**：第 1 步后、第 2 步前，把 ObjectFactory 放入三级缓存，让其他 Bean 能拿到"早期引用"。
- **单例 Bean 缓存在 DefaultSingletonBeanRegistry**。
- **initializeBean 不含属性注入**：属性注入在 populateBean，两者顺序固定。

### BeanPostProcessor —— Spring 扩展的灵魂 🔴
| BPP | 作用 |
|-----|------|
| ConfigurationClassPostProcessor | 解析 @Configuration/@Bean，注册 BeanDefinition |
| AutowiredAnnotationBeanPostProcessor | 处理 @Autowired/@Value |
| CommonAnnotationBeanPostProcessor | 处理 @PostConstruct/@PreDestroy/@Resource |
| AbstractAutoProxyCreator（AOP） | 生成代理对象 |

**写一个自定义 BPP**：
```java
@Component
public class MyBeanPostProcessor implements BeanPostProcessor {
    @Override
    public Object postProcessBeforeInitialization(Object bean, String name) {
        // 所有 Bean 初始化前都会过这里（可做日志、统计、初始化前校验）
        return bean;
    }
    @Override
    public Object postProcessAfterInitialization(Object bean, String name) {
        return bean;  // 返回原对象或代理对象
    }
}
```

### 真实案例（茶饮 SaaS 场景

优惠券计算引擎启动时要从 DB 加载规则到本地缓存：
```java
@Service
public class CouponEngine {
    private Map<Long, CouponRule> ruleCache;

    @PostConstruct  // 第 4 步触发，此时依赖已注入、容器还没对外提供服务
    public void init() {
        ruleCache = couponMapper.loadAll().stream()
            .collect(toMap(CouponRule::getId, r -> r));
        log.info("优惠券规则缓存加载完成: {}", ruleCache.size());
    }

    @PreDestroy  // 第 8 步触发，优雅释放
    public void cleanup() { ruleCache.clear(); }
}
```
踩坑：曾把加载逻辑放构造器，结果 @Autowired 的 mapper 还没注入 → NPE。改 @PostConstruct 后正常（因为 @PostConstruct 在属性注入之后）。

### 对比 / 边界

| 初始化方式 | 触发时机 | 推荐度 |
|-----------|---------|--------|
| 构造器 | 实例化（第1步，注入前）| 不推荐注入依赖初始化 |
| @PostConstruct | 第4步（注入后）| **推荐**，单一方法 |
| InitializingBean | 第5步 | 侵入框架接口，不推荐 |
| init-method | 第5步 | XML 时代，配置解耦 |

### 面试话术

「Spring 单例 Bean 生命周期分创建、初始化、销毁三大阶段。核心是 doCreateBean：先 createBeanInstance 实例化（属性是默认值），再 populateBean 注入依赖，最后 initializeBean 做 Aware 回调、BPP 前置、init 方法、BPP 后置。AOP 代理就在 BPP 后置（postProcessAfterInitialization）由 AbstractAutoProxyCreator 生成。BeanPostProcessor 是 Spring 扩展的灵魂，@Autowired、@PostConstruct、AOP 全靠它。我在优惠券引擎里用 @PostConstruct 加载规则缓存，因为它在依赖注入之后触发，能安全用注入的 mapper。」

---

## 1.3 循环依赖与三级缓存（推导 + 为什么三级）🔴🔴🔴（超高频中的高频）

### 为什么 / 痛点

**痛点**：A 依赖 B、B 依赖 A，构造时 A 要先有 B 才能造，B 要先有 A 才能造，鸡生蛋问题，直接死锁。
**Spring 的解法**：对**单例 + setter/字段注入**，把"实例化"和"初始化"拆开——A 实例化后（对象有了但属性没填），先把"半成品 A"暴露出去，让 B 能拿到，等 B 初始化完回来再填 A 的属性。三级缓存就是这套暴露机制。

### 什么是循环依赖
A 依赖 B，B 依赖 A。Spring 通过三级缓存解决**单例 + setter/字段注入**的循环依赖。

### 三级缓存（DefaultSingletonBeanRegistry 字段）
```java
/** 一级：完整的单例 Bean（成品） */
private final Map<String, Object> singletonObjects = new ConcurrentHashMap<>(256);

/** 二级：提前暴露的半成品 Bean（早期引用，可能是代理） */
private final Map<String, Object> earlySingletonObjects = new ConcurrentHashMap<>(16);

/** 三级：ObjectFactory（lambda，调用时才生成早期引用） */
private final Map<String, ObjectFactory<?>> singletonFactories = new HashMap<>(16);
```

**三级缓存分工**：
- **一级**：对外提供完整成品，getBean 命中一级直接返回。
- **二级**：缓存"已解析过的早期引用"（可能是代理），避免重复调 ObjectFactory。
- **三级**：存 ObjectFactory（lambda），**懒执行** getEarlyBeanReference，决定是否提前生成代理。

### 完整流程（以 A 依赖 B，B 依赖 A 为例）🔴

```
T0: getBean(A)
   ├─ getSingleton(A) 一级？无
   ├─ 标记 A 正在创建（singletonsCurrentlyInCreation.add(A)）
   ├─ 1. 实例化 A（构造方法，属性空）
   ├─ ★ 把 A 的 ObjectFactory 放入【三级缓存】
   │     singletonFactories.put(A, () -> getEarlyBeanReference(A))  ← 关键！
   ├─ 2. populateBean(A) 属性注入：发现需要 B → getBean(B)
   │
   │  T1: getBean(B)
   │     ├─ getSingleton(B) 一级？无
   │     ├─ 标记 B 正在创建
   │     ├─ 1. 实例化 B
   │     ├─ ★ 把 B 的 ObjectFactory 放入三级缓存
   │     ├─ 2. populateBean(B)：发现需要 A → getBean(A)
   │     │
   │     │  T2: 再次 getBean(A)
   │     │     ├─ getSingleton(A):
   │     │     │   一级？无
   │     │     │   二级？无
   │     │     │   三级？有！
   │     │     │   → 调 ObjectFactory.getObject() = getEarlyBeanReference(A)
   │     │     │     【如果 A 被 AOP，这里提前生成 AOP 代理对象】
   │     │     │   → 放入二级缓存（earlySingletonObjects.put(A, ...)）
   │     │     │   → 移除三级缓存（singletonFactories.remove(A)）
   │     │     │   → 返回 A 的早期引用（可能已是代理）
   │     │     └─ B 拿到 A 的早期引用
   │     ├─ B 属性注入完成
   │     ├─ B initializeBean（生成 B 的代理等）
   │     └─ B 完成 → 放入【一级缓存】，移除二三级
   ├─ A 拿到完整的 B
   ├─ A 属性注入完成
   ├─ A initializeBean
   ├─ ★ getSingleton(A) 再次检查：如果二级缓存有 A（说明循环依赖提前生成了代理），用二级缓存的代理
   └─ A 完成 → 放入一级缓存
```

**getSingleton 三级查找源码**（DefaultSingletonBeanRegistry）：
```java
protected Object getSingleton(String beanName, boolean allowEarlyReference) {
    Object singletonObject = this.singletonObjects.get(beanName);           // 1. 一级
    if (singletonObject == null && isSingletonCurrentlyInCreation(beanName)) {
        singletonObject = this.earlySingletonObjects.get(beanName);         // 2. 二级
        if (singletonObject == null && allowEarlyReference) {
            synchronized (this.singletonObjects) {
                singletonObject = this.singletonObjects.get(beanName);      // double-check
                if (singletonObject == null) {
                    singletonObject = this.earlySingletonObjects.get(beanName);
                    if (singletonObject == null) {
                        ObjectFactory<?> singletonFactory = this.singletonFactories.get(beanName); // 3. 三级
                        if (singletonFactory != null) {
                            singletonObject = singletonFactory.getObject(); // 调 lambda → getEarlyBeanReference
                            this.earlySingletonObjects.put(beanName, singletonObject); // 升二级
                            this.singletonFactories.remove(beanName);       // 删三级
                        }
                    }
                }
            }
        }
    }
    return singletonObject;
}
```

### 为什么三级而不是两级？🔴🔴（核心追问）

**三级缓存存的是 ObjectFactory（lambda），不是对象本身**。它的意义是**延迟决定**要不要提前生成 AOP 代理。

**假设只用两级（去掉三级 ObjectFactory）**：
- 那么必须在**实例化后立即**为每个 Bean 调 `getEarlyBeanReference` 判断是否需要代理。
- 这破坏了 Spring 的设计：AOP 代理本应在 `postProcessAfterInitialization`（第 6 步）才生成（延迟代理）。
- 强制实例化后就代理，会让**所有 Bean 都提前代理**，即使大多数 Bean 根本不需要代理。

**三级缓存的精妙之处**：
- 正常情况（无循环依赖）：三级缓存的 ObjectFactory **永远不会被调用**，AOP 在第 6 步正常生成。
- 有循环依赖时：B 才会触发 `getSingleton(A)` 调用 ObjectFactory，提前生成 A 的代理，保证 B 注入的也是代理对象。
- 这样**只在必要时才提前代理**，保留延迟代理设计。

**更深一层追问：那二级缓存有什么用？为什么不能一级+三级？**
- 没有二级缓存，每次 `getSingleton` 都会调三级 lambda，可能**重复生成代理对象**，导致 A 注入给 B 的代理和 A 最终暴露的代理不是同一个对象（违反单例语义）。
- 二级缓存缓存"已生成的早期引用"，保证全容器内 A 的早期引用唯一。

### getEarlyBeanReference 做了什么 🟡
```java
protected Object getEarlyBeanReference(String beanName, RootBeanDefinition mbd, Object bean) {
    Object exposedObject = bean;
    for (SmartInstantiationAwareBeanProcessor bp : getBeanPostProcessorCache().smartInstantiationAware) {
        // AbstractAutoProxyCreator 实现，决定是否生成代理
        exposedObject = bp.getEarlyBeanReference(exposedObject, beanName);
    }
    return exposedObject;
}
```

### 循环依赖解决不了的场景 🔴
| 场景 | 原因 |
|------|------|
| **构造器注入** | 实例化阶段就需要依赖，无法提前暴露（对象都还没建） |
| **prototype 作用域** | 每次新建，不缓存 |
| **@Async 的 Bean 循环依赖** | 异步代理（AsyncAnnotationBeanPP）不实现 getEarlyBeanReference，无法提前生成 |

**构造器注入循环依赖的解法**：改成 setter/字段注入，或用 @Lazy（注入代理，首次使用才创建）。

### 真实案例（茶饮 SaaS 场景

**现象**：项目启动报 `BeanCurrentlyInCreationException`，A(优惠券计算)→B(促销规则)→C(商品价)→A。
**排查**：看堆栈找循环链。三个 Service 互相调，本质是职责划分不清。
**解决**：
- 重构：抽公共逻辑到第三方 Bean（如 PriceContext），A/B/C 都依赖它，消除环。
- 临时（上线急）：@Lazy 注入 `@Lazy private CouponCalc a;`（注入代理，延迟解析）。
**教训**：循环依赖本质是**设计问题**，能重构就别用 @Lazy 掩盖。

### 对比 / 边界

| 注入方式 | 能否循环依赖 | 原因 |
|---------|------------|------|
| 字段/setter 注入 | 能 | 实例化与注入分离，可暴露半成品 |
| 构造器注入 | 不能 | 实例化即需依赖，无半成品可暴露 |
| prototype | 不能 | 不入缓存，每次新建 |

### 面试话术

「Spring 用三级缓存解决单例 setter/字段注入的循环依赖。一级放成品，二级放已解析的早期引用，三级放 ObjectFactory。流程是：A 实例化后把 ObjectFactory 放三级，注入 B 时发现 B 需要 A，回查 A——一级二级都没有，命中三级，调 lambda 即 getEarlyBeanReference，如果 A 被 AOP 就在这里提前生成代理，升到二级。这样 B 拿到 A 的代理，B 完成后回到 A 继续初始化。为什么三级不全两级？因为三级存的是 lambda 不是对象，正常情况不会调用，只在有循环依赖时才提前生成代理，保留了 AOP 延迟代理的设计。我项目里遇到过 Service 互调的循环依赖，本质是职责不清，最后抽公共上下文 Bean 重构解决。」

---

## 1.4 AOP 深度（代理选择 + 失效场景 + 实战）

### 为什么 / 痛点

**痛点**：日志、事务、权限、限流这些横切关注点，如果写进每个业务方法，代码重复且难维护（散落 + 耦合）。
**AOP 解决**：把这些横切逻辑抽成切面，在方法执行前后"织入"，业务代码纯净。Spring 用**运行时代理**实现：容器返回的是代理对象，调用方法时代理先执行切面逻辑再转发到目标。

### 核心概念
- **切面 Aspect**（@Aspect）、**切点 Pointcut**（@Pointcut，表达式）、**通知 Advice**（@Before/@After/@Around/@AfterReturning/@AfterThrowing）、**织入 Weaving**、**连接点 JoinPoint**。
- **通知执行顺序**：Around-before → Before → 目标方法 → AfterReturning → After → Around-after（异常时 AfterThrowing 替代 AfterReturning，After 一定执行）。

### Spring AOP vs AspectJ 🔴
| | Spring AOP | AspectJ |
|---|-----------|---------|
| 织入时机 | 运行时（代理） | 编译时/加载时（字节码增强） |
| 实现 | JDK 动态代理 / CGLIB | ajc 编译器 / LTW |
| 切点支持 | 方法级 | 方法/字段/构造器/静态初始化 |
| 性能 | 运行时稍慢 | 编织后无开销 |
| 复杂度 | 简单 | 复杂 |

### JDK 动态代理 vs CGLIB 🔴
| | JDK 动态代理 | CGLIB |
|---|-------------|-------|
| 原理 | 实现 InvocationHandler，目标需接口 | 继承目标类生成子类 + MethodInterceptor |
| 要求 | 必须有接口 | 不能是 final 类/方法 |
| 性能 | 创建快，调用稍慢 | 创建慢，调用快（FastClass 索引避免反射） |
| SpringBoot 2.x | 默认 CGLIB（proxy-target-class=true） | |

**JDK 动态代理示例**：
```java
public interface UserService { void save(); }
public class UserServiceImpl implements UserService { public void save() { ... } }

UserService target = new UserServiceImpl();
UserService proxy = (UserService) Proxy.newProxyInstance(
    target.getClass().getClassLoader(),
    new Class[]{UserService.class},
    (p, method, args) -> {
        System.out.println("before");           // 前置
        Object ret = method.invoke(target, args); // 转发目标
        System.out.println("after");            // 后置
        return ret;
    });
proxy.save();
```

**CGLIB 示例**：
```java
Enhancer enhancer = new Enhancer();
enhancer.setSuperclass(UserServiceImpl.class);  // 继承目标类
enhancer.setCallback((MethodInterceptor)(obj, method, args, proxy) -> {
    System.out.println("before");
    Object ret = proxy.invokeSuper(obj, args);  // 调父类（目标）方法
    System.out.println("after");
    return ret;
});
UserServiceImpl proxy = (UserServiceImpl) enhancer.create();
```

### AOP 代理生成时机 🔴
- 在 `AbstractAutoProxyCreator.postProcessAfterInitialization`：
```java
public Object postProcessAfterInitialization(Object bean, String beanName) {
    if (advisedBeans.containsKey(cacheKey)) return bean;
    return wrapIfNecessary(bean, beanName, cacheKey);  // 包装成代理
}
```
- 但如果有循环依赖，会通过 `getEarlyBeanReference` 提前生成代理（见 1.3）。

### 🔴 AOP 失效场景：this 调用不走代理

```java
@Service
public class OrderService {
    public void a() {
        b();  // 等价 this.b()，this 是目标对象，不是代理！
    }
    @Transactional
    public void b() { ... }
}
```

**原理**：
```
调用方 → 代理对象.a()  → 经过事务/AOP 增强
            ↓ 代理对象内部调用 target.a()（目标对象）
            target.a() 内部 this.b()
            this = target（不是代理）
            → b() 不经过代理 → @Transactional 失效！
```

**解法** 🔴：
1. **注入自己**：
   ```java
   @Service
   public class OrderService {
       @Autowired @Lazy
       private OrderService self;  // 注入的是代理
       public void a() { self.b(); }  // 走代理
   }
   ```
2. **AopContext.currentProxy()**（需 `@EnableAspectJAutoProxy(exposeProxy = true)`）：
   ```java
   ((OrderService) AopContext.currentProxy()).b();
   ```
3. **拆到不同类**（最干净）。

### 真实案例（茶饮 SaaS 场景

前司门店端接口用 AOP 统一记录调用日志和操作人：
```java
@Aspect
@Component
@Slf4j
public class WebLogAspect {
    @Pointcut("@annotation(org.springframework.web.bind.annotation.RequestMapping)")
    public void webPoint() {}

    @Around("webPoint()")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.currentTimeMillis();
        String user = UserContextHolder.get();  // 从 ThreadLocal 拿操作人
        try {
            Object ret = pjp.proceed();
            log.info("[{}] {} args={} cost={}ms", user, pjp.getSignature(), pjp.getArgs(), System.currentTimeMillis()-start);
            return ret;
        } catch (Throwable e) {
            log.error("[{}] {} 异常", user, pjp.getSignature(), e);
            throw e;
        }
    }
}
```
配合 Sentinel 做门店接口限流（见 3.5）。注意：切点只匹配 Controller 层方法（被 Spring 代理的 Bean），内部 this 调用不会触发。

### 对比 / 边界

| 维度 | AOP | 装饰器/拦截器手动写 |
|------|-----|------------------|
| 复用 | 配置化，多切面叠加 | 代码重复 |
| 灵活度 | 切点表达式 | 逐个写 |
| 性能 | 代理反射开销 | 直接调用 |
| 适用 | 横切关注点 | 单点增强 |

**适用边界**：AOP 适合方法级横切；字段级、构造器级增强要用 AspectJ；性能极致场景（高频小方法）慎用 AOP 反射开销。

### 面试话术

「Spring AOP 是基于代理的运行时织入，BeanPostProcessor 后置阶段由 AbstractAutoProxyCreator 生成代理。如果目标有接口走 JDK 动态代理，没有就走 CGLIB，SpringBoot 2.x 默认 CGLIB。最大的坑是 this 调用失效——代理对象调目标方法，目标里 this 是目标自己不是代理，所以 self.xxx() 的 @Transactional 不生效。解法是注入自己（@Lazy self）走代理，或 AopContext.currentProxy()，最干净是拆类。我在前司用 AOP 统一做门店接口的日志和操作人埋点，切点匹配 Controller，一次实现全链路覆盖。」

---

## 1.5 @Transactional 深度（传播行为 + 失效 + 原理）🔴🔴

### 为什么 / 痛点

**痛点**：业务方法里多步 DB 操作（扣库存、写订单、扣款）必须"要么全成功要么全回滚"，手写 `conn.setAutoCommit(false)...try commit/finally rollback` 重复且易错；而且要和 Spring 容器、连接池、多方法调用协同。
**@Transactional 解决**：声明式事务——AOP 拦截 + 事务管理器，开发者只标注解，事务边界、连接绑定、回滚规则全部交给框架。

### 传播行为 7 种详解 🔴

| 传播行为 | 外层无事务 | 外层有事务 |
|---------|-----------|-----------|
| **REQUIRED**（默认） | 新建 | 加入 |
| **REQUIRES_NEW** | 新建 | **挂起外层**，新建 |
| **NESTED** | 新建 | **嵌套**（savepoint） |
| SUPPORTS | 非事务 | 加入 |
| NOT_SUPPORTED | 非事务 | 挂起外层，非事务执行 |
| MANDATORY | 抛异常 | 加入 |
| NEVER | 非事务 | 抛异常 |

**REQUIRES_NEW vs NESTED 区别** 🔴：
- REQUIRES_NEW：**物理独立**事务，外层失败不影响内层（已提交），内层失败外层可继续。
- NESTED：**逻辑嵌套**（基于 savepoint），内层失败回滚到 savepoint，外层可继续或整体回滚；外层失败内层一起回滚。

```
REQUIRES_NEW：外层挂起，内层独立提交/回滚。两个物理事务。
   外层conn ──挂起──>  内层conn（独立）──提交──>  外层conn恢复
NESTED：外层内层同一物理事务，内层用 savepoint 标记。
   外层conn ──savepoint sp1──>  内层操作  ──失败回滚到 sp1──>  外层继续/整体 commit
```

### 🔴 @Transactional 7 大失效场景（必背）

| # | 场景 | 原因 |
|---|------|------|
| 1 | **方法非 public** | AOP 默认只代理 public 方法 |
| 2 | **self 调用（this.xxx）** | 不走代理（见 1.4） |
| 3 | **异常被 catch 吞掉** | Spring 靠抛异常感知回滚 |
| 4 | **rollbackFor 默认只回 RuntimeException/Error** | 受检异常默认不回滚，加 `rollbackFor = Exception.class` |
| 5 | **数据库引擎不支持事务** | MyISAM 无事务 |
| 6 | **传播行为 NOT_SUPPORTED/NEVER** | 故意不用事务 |
| 7 | **Bean 没被 Spring 管理** | new 出来的没代理 |

**额外坑**：
- 抛异常后 catch 住又抛**非 RuntimeException**（如自定义 Exception extends Exception）→ 默认不回滚。
- 多线程：子线程不共享事务（事务绑定在 ThreadLocal 的 Connection）。
- `final`/`static` 方法不能被代理（CGLIB 不能覆写 final，static 不参与代理）。

### @Transactional 实现原理 🔴
```
@Transactional
↓ AOP 拦截（TransactionInterceptor）
↓ PlatformTransactionManager.getTransaction()  ← 开启/获取事务
   ↓ 绑定 Connection 到 ThreadLocal（TransactionSynchronizationManager）
↓ 执行业务方法（用同一个 Connection）
   成功 → commit()
   异常 → rollback()（判断 rollbackFor）
```

**TransactionInterceptor 核心逻辑**（简化）：
```java
public Object invoke(MethodInvocation inv) throws Throwable {
    TransactionAttribute txAttr = computeAttribute(inv);           // 解析 @Transactional
    PlatformTransactionManager tm = determineTM();                 // 选事务管理器
    TransactionStatus txStatus = tm.getTransaction(txAttr);        // 开启/加入事务
    try {
        Object ret = inv.proceed();                                // 业务方法
        commitTransactionAfterReturning(txStatus);                 // 提交
        return ret;
    } catch (Throwable ex) {
        if (rollbackOn(ex, txAttr)) completeTransactionAfterThrowing(txStatus, ex); // 回滚
        else commitTransactionAfterReturning(txStatus);            // 不回滚则提交
        throw ex;
    }
}
```

**为什么同事务内多个方法用同一个 Connection？** 🔴
- 事务开启时，Connection 绑定到 `TransactionSynchronizationManager` 的 ThreadLocal。
- MyBatis/JPA 通过 `DataSourceUtils.getConnection()` 获取，优先从 ThreadLocal 拿（事务内的 Connection），没有才从连接池拿。
- 这就是为什么多线程不共享事务——ThreadLocal 隔离。

### 真实案例（茶饮 SaaS 场景

**现象**：优惠券核销 + 积分发放，核销成功但积分发放异常，券没了积分没到。
**排查**：
```java
@Service
public class CouponService {
    public void use(Long couponId, Long userId) {
        couponMapper.markUsed(couponId);       // 核销券
        pointService.add(userId, 10);          // 发积分（抛异常）
    }
}
```
`CouponService.use()` 没加 @Transactional，couponMapper 用的是 Spring 默认（SqlSessionTemplate 自动提交），markUsed 立即提交；pointService.add 异常只回滚自己的事务。券真没了积分没到。
**解决**：`use()` 加 `@Transactional(rollbackFor = Exception.class)`，两步同一事务，要么都成要么都败。
**教训**：跨方法调用要清楚事务边界，必要时提升到外层统一管理；roll backFor 必须显式扩到 Exception，否则受检异常不回滚。

### 对比 / 边界

| 维度 | 编程式事务 | 声明式 @Transactional |
|------|----------|---------------------|
| 灵活 | 精确控制范围 | 方法级 |
| 侵入 | 高（业务混事务代码）| 低（注解）|
| 适用 | 局部小事务 | 大多数业务 |

**适用边界**：@Transactional 适合业务方法；批量大数据导入（几万行）用编程式分段提交，避免长事务锁表。

### 面试话术

「@Transactional 本质是 AOP，TransactionInterceptor 在方法前用 PlatformTransactionManager 开启事务、把 Connection 绑定 ThreadLocal，方法正常提交、抛异常按 rollbackFor 回滚。默认只回滚 RuntimeException，所以我习惯加 rollbackFor=Exception.class。最常踩的坑是 self 调用失效——this 不是代理，还有异常被 catch 吞掉。传播行为默认 REQUIRED，REQUIRES_NEW 是独立物理事务（外层挂起），NESTED 是同事务的 savepoint 嵌套。我在前司遇到过券核销和积分发放不在同一事务，核销成功积分失败导致数据不一致，根因就是外层方法漏了 @Transactional，补上后两步原子化。」

---

# 第二篇 SpringBoot

## 2.1 自动配置原理（源码级）🔴🔴

### 为什么 / 痛点

**痛点**：传统 Spring 要写一堆 XML 配 Bean（数据源、事务管理器、MVC），每开一个项目重复搬，且容易漏配。
**SpringBoot 解决**："约定大于配置 + 自动装配"——把常用组件的默认配置打成 Starter，按 classpath 里有什么类、用户配了什么属性，**自动**注册合适的 Bean。开发者只引依赖、改 yml，零配置启动。

### 入口
```java
@SpringBootApplication
// = @SpringBootConfiguration + @EnableAutoConfiguration + @ComponentScan
```
- `@SpringBootConfiguration`：本质 @Configuration，标主配置类。
- `@ComponentScan`：扫描主类包及子包的 @Component。
- `@EnableAutoConfiguration`：自动配置核心。

### @EnableAutoConfiguration 流程

```java
@AutoConfigurationPackage
@Import(AutoConfigurationImportSelector.class)
public @interface EnableAutoConfiguration { }
```

**AutoConfigurationImportSelector.selectImports 核心流程**：
```java
public String[] selectImports(AnnotationMetadata metadata) {
    // 1. 加载候选配置类
    List<String> configurations = getCandidateConfigurations(annotationMetadata, attributes);
    // 2. 去重
    configurations = removeDuplicates(configurations);
    // 3. 按 @AutoConfigureOrder/@AutoConfigureAfter 排序
    configurations = sortAutoConfigurations(...);
    // 4. 过滤（@Conditional）
    configurations = filter(configurations, autoConfigurationMetadata);
    return configurations.toArray(new String[0]);
}

protected List<String> getCandidateConfigurations(...) {
    // SpringBoot 2.x：从 META-INF/spring.factories 读
    // SpringBoot 3.x：从 META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports 读
    List<String> configurations = ImportCandidates.load(AutoConfiguration.class, ...).getCandidates();
    return configurations;
}
```

### @Conditional 过滤机制 🔴
| 条件注解 | 含义 |
|---------|---------|
| @ConditionalOnClass | 类路径有某类才生效 |
| @ConditionalOnMissingClass | 类路径无某类 |
| @ConditionalOnBean | 容器有某 Bean |
| @ConditionalOnMissingBean | 容器无某 Bean（让用户自定义优先）|
| @ConditionalOnProperty | 配置项满足（prefix + name + havingValue） |
| @ConditionalOnWebApplication | 是 Web 应用 |
| @ConditionalOnNotWebApplication | 非 Web 应用 |
| @ConditionalOnExpression | SpEL 表达式 |

### 自动配置示例（DataSourceAutoConfiguration 简化）
```java
@AutoConfiguration
@ConditionalOnClass({ DataSource.class, EmbeddedDatabaseType.class })
@ConditionalOnMissingBean(type = "io.r2dbc.spi.ConnectionFactory")
@EnableConfigurationProperties(DataSourceProperties.class)
@Import({ DataSourcePoolMetadataProvidersConfiguration.class, ... })
public class DataSourceAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean  // ← 用户没自定义才用默认
    public DataSource dataSource(DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().build();
    }
}
```

**关键设计**：`@ConditionalOnMissingBean` 让**用户自定义 Bean 优先**，覆盖默认配置。这就是 SpringBoot "约定大于配置 + 允许覆盖"的核心。

### 真实案例（茶饮 SaaS 场景

前司有主库（订单）和报表库（统计），默认 DataSourceAutoConfiguration 只配一个 DataSource。我们用 @Configuration 自己配两个 DataSource Bean，因为 `@ConditionalOnMissingBean`，SpringBoot 默认的就不生效，完美覆盖。

### 对比 / 边界

| 维度 | XML 配置 | 自动配置 |
|------|---------|---------|
| 配置量 | 多 | 少（约定默认）|
| 灵活 | 高 | 中（默认可覆盖）|
| 上手 | 难 | 易 |
| 透明度 | 高 | 低（黑盒）|

**适用边界**：自动配置适合标准场景；复杂定制（多数据源、自定义拦截器链）仍需 @Configuration 显式覆盖。

### 面试话术

「SpringBoot 自动配置入口是 @SpringBootApplication 里的 @EnableAutoConfiguration，它 @Import 了 AutoConfigurationImportSelector。selectImports 里先从 META-INF/spring.factories（2.x）或 AutoConfiguration.imports（3.x）加载所有候选配置类，去重排序，再用 @Conditional 过滤——@ConditionalOnClass 看类路径有没有，@ConditionalOnBean 看容器有没有，最关键的是 @ConditionalOnMissingBean，让用户自定义 Bean 优先覆盖默认。DataSourceAutoConfiguration 就是这样：引了 jdbc 依赖、用户没自己配 DataSource，它才生效。我在前司配多数据源时就是利用这个机制，自定义两个 DataSource Bean 覆盖默认。」

---

## 2.2 自定义 Starter 实战 🔴

### 为什么 / 痛点

**痛点**：团队内多个项目都要用同一套组件（如统一的短信 SDK、统一的权限校验），每个项目复制代码难维护，升级要改多处。
**Starter 解决**：把组件 + 默认配置打成 Starter，引依赖即用，配置集中在 yml，升级改一处。

### 结构
```
my-spring-boot-starter/
├── my-spring-boot-autoconfigure/
│   ├── src/main/java/com/xx/autoconf/
│   │   ├── MyProperties.java        (@ConfigurationProperties)
│   │   ├── MyService.java
│   │   └── MyAutoConfiguration.java (@Configuration + @Conditional)
│   └── src/main/resources/META-INF/spring/
│       └── org.springframework.boot.autoconfigure.AutoConfiguration.imports
│           (内容：com.xx.autoconf.MyAutoConfiguration)
└── my-spring-boot-starter/          (只打包依赖)
    └── pom.xml
```

### 完整代码

**MyProperties**：
```java
@ConfigurationProperties(prefix = "my")  // 读 my.xxx 配置
@Data
public class MyProperties {
    private boolean enabled = true;      // my.enabled
    private String name = "default";     // my.name
    private int timeout = 3000;          // my.timeout
}
```

**MyService**：
```java
public class MyService {
    private final MyProperties props;
    public MyService(MyProperties props) { this.props = props; }
    public String greet() { return "hello " + props.getName(); }
}
```

**MyAutoConfiguration**：
```java
@AutoConfiguration
@ConditionalOnClass(MyService.class)
@EnableConfigurationProperties(MyProperties.class)
public class MyAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean
    @ConditionalOnProperty(prefix = "my", name = "enabled", havingValue = "true", matchIfMissing = true)
    public MyService myService(MyProperties props) {
        return new MyService(props);
    }
}
```

**声明文件**（3.x）：
```
# META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.xx.autoconf.MyAutoConfiguration
```

### 真实案例（茶饮 SaaS 场景

前司多个 SaaS 服务都要校验门店 token，封装成 `qw-auth-spring-boot-starter`：引依赖 + yml 配开关，自动注入鉴权 Filter + Gateway 全局过滤器（见 3.6），各服务零代码接入。

### 对比 / 边界

| 维度 | 公共 jar | Starter |
|------|---------|---------|
| 配置 | 手动 @Bean | 自动装配 |
| 升级 | 改业务代码 | 改依赖版本 |
| 灵活 | 低 | 高（@Conditional）|

### 面试话术

「自定义 Starter 分 autoconfigure 和 starter 两个模块：autoconfigure 写 @ConfigurationProperties 配置类、业务 Service、@AutoConfiguration 配置类（带 @ConditionalOnClass/@ConditionalOnMissingBean/@ConditionalOnProperty），然后在 META-INF/spring/AutoConfiguration.imports（3.x）或 spring.factories（2.x）声明配置类全名。starter 模块只打依赖。@ConditionalOnMissingBean 让用户能覆盖默认，@ConditionalOnProperty 让用户用 yml 开关。我在前司做过统一鉴权 Starter，多服务引依赖即接入门店 token 校验。」

---

## 2.3 启动流程（refresh 详解）🟡

### 为什么 / 痛点

**痛点**：理解启动流程才能定位"启动慢""Bean 没找到""Tomcat 没起来"等问题。
**核心**：SpringApplication.run → refresh 12 步，每步职责清晰。

### 启动流程图
```
SpringApplication.run()
1. new SpringApplication()
   - 推断应用类型（SERVLET/REACTIVE/NONE，看 classpath）
   - 从 spring.factories 加载 ApplicationContextInitializer、ApplicationListener
2. run()
   - 启动计时
   - prepareEnvironment：读 application.yml/properties + 命令行参数
   - createApplicationContext（Servlet 用 AnnotationConfigServletWebServerApplicationContext）
   - prepareContext：注册主配置类、执行 initializer
   - ★ refreshContext → AbstractApplicationContext.refresh()
     │
     │  refresh 12 步核心：
     │  1. prepareRefresh：准备、校验
     │  2. obtainFreshBeanFactory：加载 BeanDefinition
     │  3. prepareBeanFactory：配置 factory
     │  4. postProcessBeanFactory：子类扩展点
     │  5. invokeBeanFactoryPostProcessors：★ ConfigurationClassPP 解析 @Configuration
     │  6. registerBeanPostProcessors：注册 BPP
     │  7. initMessageSource
     │  8. initApplicationEventMulticaster
     │  9. ★ onRefresh：创建 WebServer（内嵌 Tomcat 启动）
     │  10. registerListeners
     │  11. ★ finishBeanFactoryInitialization：实例化所有非懒加载单例 Bean（核心！）
     │  12. finishRefresh：发布 ContextRefreshedEvent、启动 Tomcat connector
   - afterRefresh、发布 ApplicationStartedEvent、ApplicationReadyEvent
```

**关键节点**：
- 第 5 步：解析 @Configuration/@Bean/@ComponentScan，注册 BeanDefinition（**还没实例化**）。
- 第 6 步：注册 BeanPostProcessor（**还没用**）。
- 第 9 步 onRefresh：创建内嵌 Tomcat（**还没接收请求**）。
- 第 11 步：实例化所有非懒加载单例 Bean（最耗时，AOP/事务代理在此生成）。
- 第 12 步 finishRefresh：启动 Tomcat connector，开始接收请求。

**内嵌 Tomcat 启动时机**：`onRefresh() → createWebServer()` 创建，connector 在 `finishRefresh` 启动（接收请求）。

### 真实案例（茶饮 SaaS 场景

前司某服务启动 90s，排查发现 finishBeanFactoryInitialization 阶段慢——有个 @PostConstruct 里同步加载 10 万条规则到内存。优化：改 @PostConstruct 异步加载 + 启动后并行预热，启动降到 30s。

### 对比 / 边界

| 阶段 | 失败现象 | 排查方向 |
|------|---------|---------|
| 第5步 BeanDefinition 注册 | Bean not found | @ComponentScan 范围、@Import |
| 第11步 Bean 实例化 | 循环依赖、NPE | @Autowired 链、@PostConstruct |
| 第9步 Tomcat | 端口占用 | 端口冲突、socket |

### 面试话术

「SpringApplication.run 先 new SpringApplication 推断应用类型、加载 Initializer/Listener，然后 run 里准备环境、创建 ApplicationContext、refresh。refresh 12 步最关键三步：第 5 步 invokeBeanFactoryPostProcessors 由 ConfigurationClassPostProcessor 解析 @Configuration 注册 BeanDefinition；第 9 步 onRefresh 创建内嵌 Tomcat；第 11 步 finishBeanFactoryInitialization 实例化所有非懒加载单例，最耗时，AOP 代理也在这一步生成；第 12 步 finishRefresh 启动 Tomcat connector 开始接请求。我优化过启动慢，根因是 @PostConstruct 同步加载大量数据，改异步预热后从 90s 降到 30s。」

---

# 第三篇 Spring Cloud 微服务

## 3.1 微服务全景 + 组件对照

### 为什么 / 痛点

**单体痛点**：代码膨胀、部署慢、技术栈单一、扩容只能整体扩、一处 OOM 全挂。
**微服务解决**：按业务拆分、独立部署、独立技术栈、独立扩容。但引入分布式复杂性：服务发现、配置、网关、熔断、链路、分布式事务。

### 组件对照

| 能力 | Netflix（一代，停更） | Alibaba（主流） |
|------|---------------------|----------------|
| 注册中心 | Eureka | **Nacos** |
| 配置中心 | Config + Bus | **Nacos** |
| 网关 | Zuul | **Spring Cloud Gateway** |
| 负载均衡 | Ribbon | LoadBalancer / Dubbo 内置 |
| 声明式调用 | Feign | OpenFeign / Dubbo |
| 熔断降级 | Hystrix | **Sentinel** |
| 链路追踪 | Sleuth + Zipkin | SkyWalking |
| 分布式事务 | — | **Seata** |

### SpringBoot vs SpringCloud 🔴

| 维度 | SpringBoot | SpringCloud |
|------|-----------|-------------|
| 关注 | 单应用快速开发 | 分布式系统协调 |
| 依赖 | spring-boot-starter-* | spring-cloud-starter-*（基于 Boot）|
| 关系 | 基础 | 上层（需 Boot 支撑）|
| 组件 | 自动配置、Starter | 注册、配置、网关、熔断 |

### 面试话术

「微服务把单体按业务拆分独立部署，解决单体膨胀和扩容问题，但引入分布式复杂性。SpringCloud 是微服务治理全家桶，Netflix 一代已停更，现在主流 Alibaba：Nacos 注册+配置、Gateway 网关、Sentinel 熔断限流、Seata 分布式事务、Dubbo RPC。SpringBoot 是单应用快速开发框架，SpringCloud 是基于 Boot 的分布式协调层。我在前司 SaaS 茶饮后端用整套 Alibaba 栈，Nacos 注册几百个门店服务和促销服务实例。」

---

## 3.2 注册中心：Nacos vs Eureka vs ZK（CAP 详解）🔴🔴

### 为什么 / 痛点

**痛点**：微服务实例动态上下线（扩容、重启、宕机），调用方要知道"现在哪些实例活着、地址是什么"。硬编码地址不现实，需要注册中心做服务发现。

### CAP 模型
| 注册中心 | CAP | 说明 |
|---------|-----|------|
| Eureka | AP | 去中心化复制，保证可用性 |
| Zookeeper | CP | ZAB 强一致，leader 选举期不可用 |
| Nacos | **AP + CP 双模** | 临时实例 AP（Distro 协议），持久实例 CP（Raft） |

```
CAP 三选二：
  C 一致性：所有节点同一时刻数据一致
  A 可用性：每次请求都有响应（不保证最新）
  P 分区容忍：网络分区时仍能工作（分布式必选）

注册中心 = P 必选 + 在 C/A 间权衡
  Eureka/Nacos(临时) 选 AP：分区时返回旧数据，不阻塞查询
  ZK/Nacos(持久) 选 CP：分区时拒绝不一致的写
```

### 🔴 为什么注册中心用 AP 而非 CP？

**核心论点**：注册中心的核心价值是**可用性**，服务发现不能因一致性协议阻塞。

1. **分区容忍优先**：网络分区时，宁可返回旧数据，也不能拒绝查询（查询不到 = 服务不可用）。
2. **短暂不一致可接受**：某节点还有"已下线服务"的旧数据 → 客户端调用失败 → **重试/熔断**兜底 → 业务可恢复。
3. **CP 的代价不可接受**：ZK leader 选举期间（几秒到几十秒）**整个集群不可用** → 服务发现全部失败 → 雪崩。
4. **CAP 的 A 不等于"高可用"**：AP 指分区时仍能响应（可能不一致），而非 SLA 高可用。

### Nacos 如何兼顾 AP/CP 🔴
- **临时实例**（AP）：客户端 5s 心跳上报，节点间用 **Distro 协议**（AP）同步。适合**服务发现**（实例上线快、容忍短暂不一致）。
- **持久实例**（CP）：服务端主动探测，用 **Raft 协议**（CP）同步。适合**配置、DB 元数据**等强一致需求。

### Nacos 健康检查
- 临时实例：客户端 5s 心跳 → 15s 标记不健康 → 30s 摘除。
- 持久实例：服务端 TCP/HTTP 主动探测。

**Nacos 注册流程**：
```
Provider 启动
  → NacosClient 向 NacosServer 发 POST /nacos/v1/ns/instance（注册临时实例）
  → 开启 5s 心跳线程 PUT /nacos/v1/ns/instance/beat
Consumer 启动
  → 订阅服务（长轮询）GET /nacos/v1/ns/instance/list
  → NacosServer 推送实例列表变更
  → Consumer 本地缓存实例列表 + 软负载选实例调用
```

### 真实案例（茶饮 SaaS 场景

前司门店端几百个服务实例注册到 Nacos，门店高峰期实例扩容，Nacos 5s 内推送新实例列表，调用方无感切换。某次 Nacos 集群网络抖动分区，因 AP 模式查询没断，业务靠熔断兜底，几秒后恢复。

### 对比 / 边界

| 维度 | Eureka | ZK | Nacos | Consul |
|------|--------|----|----|--------|
| CAP | AP | CP | AP+CP | CP+AP |
| 一致性协议 | 去中心化复制 | ZAB | Distro+Raft | Raft |
| 语言 | Java | Java | Java | Go |
| 配置中心 | 弱 | 弱 | **强** | 中 |
| 推送 | 客户端轮询 | Watch | 长轮询+UDP | 长轮询 |

### 面试话术

「注册中心选型核心是 CAP。Eureka 走 AP，去中心化复制，分区时返回旧数据不阻塞；ZK 走 CP，ZAB 强一致，但 leader 选举期间整个集群不可用，对服务发现是灾难。注册中心为什么选 AP？因为服务发现的核心价值是可用性，宁可返回旧数据让客户端重试熔断兜底，也不能查询失败导致雪崩。Nacos 兼顾两者：临时实例用 Distro 协议走 AP 适合服务发现，持久实例用 Raft 走 CP 适合配置。前司门店服务全注册 Nacos，扩容时 5 秒推送新实例，调用方无感。」

---

## 3.3 Ribbon / LoadBalancer 负载均衡 🟡

### 为什么 / 痛点

**痛点**：一个服务多实例，调用方怎么选？服务端 LB（Nginx）多一跳且单点；客户端 LB 自己选实例直连，少一跳、性能好、可定制（灰度）。

### 原理
- **客户端负载均衡**（vs Nginx 服务端 LB）。
- 核心：IRule（策略）+ ILoadBalancer + ServerList（从注册中心拿列表）。
- 策略：
  - RoundRobin（轮询，默认）
  - Random（随机）
  - BestAvailable（最少并发）
  - WeightedResponseTime（按 RT 加权）
  - Retry（重试 + 其他策略）
  - ZoneAvoidance（多机房感知）
- 自定义：基于 Metadata（如灰度 env 标签）路由。
- Spring Cloud 2020+ 用 Spring Cloud LoadBalancer 替代 Ribbon。

```
Feign/RestTemplate 调 order-service
  → LoadBalancerIntercepter 拦截
  → 从 Nacos 拿 order-service 实例列表 [ip1, ip2, ip3]
  → IRule.choose() 选一个（如轮询 ip2）
  → 用真实 ip2:port 发请求
```

### 真实案例（茶饮 SaaS 场景

前司促销服务灰度发布，自定义 IRule：从 RequestHeader 取 env 灰度标签，优先选 metadata 匹配的实例，没匹配再走默认轮询。

### 对比 / 边界

| 维度 | 客户端 LB（Ribbon）| 服务端 LB（Nginx）|
|------|------------------|-----------------|
| 跳数 | 少一跳（直连）| 多一跳 |
| 定制 | 强（IRule）| 中 |
| 单点 | 无 | 有（要高可用集群）|
| 多语言 | SDK 绑定语言 | 语言无关 |

### 面试话术

「Ribbon 是客户端负载均衡，调用方从注册中心拉实例列表，本地用 IRule 选一个直连，比 Nginx 少一跳。策略有轮询、随机、最少并发、加权 RT、多机房感知。我在前司做过灰度路由，自定义 IRule 从请求头取灰度标签，优先匹配实例 metadata，实现促销服务灰度发布。Spring Cloud 2020 后 Ribbon 被官方 LoadBalancer 替代，原理类似。」

---

## 3.4 Feign / OpenFeign 🔴

### 为什么 / 痛点

**痛点**：服务间 HTTP 调用要手写 HttpClient、拼 URL、序列化、处理异常，重复且易错。
**Feign 解决**：声明式——写个接口加注解，Feign 生成代理，像调本地方法一样调远程。

### 原理
```
@EnableFeignClients 扫描 @FeignClient 接口
  → 为每个接口生成 JDK 动态代理（FeignClientFactoryBean）
  → 代理方法调用：
     1. 解析注解（url/path/param）构造 RequestTemplate
     2. 负载均衡选实例（LoadBalancer）
     3. HTTP 客户端（HttpURLConnection/OkHttp/Apache HttpClient）发请求
     4. 解码响应
```

### 集成 Sentinel
```java
@FeignClient(name = "order", fallback = OrderFallback.class)
public interface OrderClient {
    @GetMapping("/orders/{id}")
    Order get(@PathVariable Long id);
}

@Component
public class OrderFallback implements OrderClient {
    @Override
    public Order get(Long id) {
        return Order.degraded();  // 降级返回
    }
}
```
- Feign.builder 注入 `SentinelInvocationHandler`，每个方法一个资源。
- 熔断时调 fallback 或抛异常。

### 超时配置
```yaml
feign:
  client:
    config:
      default:
        connect-timeout: 1000
        read-timeout: 3000
      order-service:  # 针对特定服务
        read-timeout: 5000
```

### 真实案例（茶饮 SaaS 场景

前司优惠券计算要查商品价格，用 Feign 调商品服务，配 fallback——商品服务抖动时返回缓存价，保证优惠券计算不阻塞。

### 对比 / 边界

| 维度 | Feign | RestTemplate | Dubbo |
|------|-------|-------------|-------|
| 风格 | 声明式接口 | 编程式 | 声明式接口 |
| 协议 | HTTP | HTTP | TCP（自定义）|
| 性能 | 中 | 中 | 高 |
| 跨语言 | 是 | 是 | 否（triple 协议是）|

### 面试话术

「Feign 是声明式 HTTP 客户端，@EnableFeignClients 扫描 @FeignClient 接口，FeignClientFactoryBean 为每个接口生成 JDK 动态代理。调用时解析注解构造 RequestTemplate，经负载均衡选实例，HTTP 客户端发请求解码响应。集成 Sentinel 是注入 SentinelInvocationHandler，每个方法一个资源，熔断调 fallback。我在前司优惠券调商品服务用 Feign + fallback，商品服务抖动时返回缓存价保证计算不阻塞。注意超时要配 connect-timeout/read-timeout，避免单次调用拖垮线程池。」

---

## 3.5 熔断降级：Sentinel vs Hystrix 🔴🔴

### 为什么 / 痛点

**痛点**：微服务调用链中，下游服务慢或挂，调用方线程堆积 → 自己也挂 → 雪崩。
**熔断解决**：监测下游健康（慢调用比例、异常比例、异常数），不健康时"熔断"快速失败，保护调用方；恢复后自动"半开"试探。

### 对比
| | Hystrix | Sentinel |
|---|---------|----------|
| 隔离策略 | 线程池/信号量 | **信号量**（轻量，无线程切换） |
| 熔断策略 | 异常比例 | **慢调用比例 / 异常比例 / 异常数** |
| 实时统计 | 滑动窗口（BucketedCounterStream） | 滑动窗口（**LeapArray**，高性能） |
| 流控 | 无 | **QPS + 并发线程数 + 流控效果** |
| 系统自适应 | 无 | **有**（基于 Load/CPU/RT/线程数，BBR 思想） |
| 控制台 | 弱（Dashboard） | **强**（Sentinel Dashboard，规则动态推送） |
| 状态 | 停更 | 活跃 |

### Sentinel 滑动窗口（LeapArray）原理 🟡
```
窗口 = 时间轮（LeapArray）
每个样本桶（WindowWrap）：windowStart + value
sampleCount（桶数，默认 2）+ intervalInMs（窗口时长，默认 1s）
统计时：定位当前桶 + 累加历史桶
无锁（CAS 更新），高性能。
```

```
时间轴：|----桶0----|----桶1----|----桶0----|----桶1----|
        0ms       500ms      1000ms     1500ms     2000ms
统计窗口(1s, 2桶)：当前在桶1(1500-2000)时，QPS = 桶0(1000-1500) + 桶1(1500-now)
  → 滑动覆盖最近1秒数据
```

### Sentinel 流控效果 🔴
- **快速失败**：直接拒绝超出部分。
- **Warm Up（冷启动）**：开始只放少量（threshold/3），预热时长后到阈值。适合 DB 等需预热。
- **匀速排队**（漏桶）：请求匀速通过，超出排队等待。适合突发流量削峰（如 MQ 消费保护 DB）。

### 熔断规则（3 种触发）
- **慢调用比例**：RT > 阈值的请求占比 > 比例，持续时长后熔断。
- **异常比例**：异常请求占比 > 比例 → 熔断。
- **异常数**：异常数 > 阈值 → 熔断。

### 真实案例（茶饮 SaaS 场景

前司门店端高峰期下单接口 QPS 暴涨，给 `/order/create` 配 Sentinel 流控：QPS 阈值 2000，超了快速失败返回"系统繁忙"。配合 Warm Up 让数据库连接池预热，避免冷启动打满。规则通过 Sentinel Dashboard 推送，无需重启。

### 对比 / 边界

| 维度 | Sentinel | Hystrix | Resilience4j |
|------|----------|---------|-------------|
| 隔离 | 信号量 | 线程池/信号量 | 信号量/桶 |
| 流控 | 强 | 无 | 中 |
| 控制台 | 强 | 弱 | 无 |
| 现状 | 活跃 | 停更 | 活跃（Spring 推荐）|

### 面试话术

「Sentinel 是阿里熔断限流组件，比 Hystrix 强在流控、系统自适应、控制台。隔离用信号量（无线程切换开销），统计用 LeapArray 滑动窗口（时间轮 + CAS 无锁，高性能）。流控三种效果：快速失败、Warm Up 冷启动预热、匀速排队漏桶削峰。熔断三种触发：慢调用比例、异常比例、异常数。我在前司给门店下单接口配 QPS 限流，高峰超阈值快速失败，配合 Warm Up 预热数据库连接池，规则通过 Dashboard 推送免重启。」

---

## 3.6 网关：Spring Cloud Gateway 🔴

### 为什么 / 痛点

**痛点**：微服务对外暴露几十个服务，客户端直连不现实；且鉴权、限流、日志、协议转换、灰度这些横切逻辑无处安放。
**网关解决**：统一入口，做路由、鉴权、限流、熔断、日志、协议转换、灰度。

### 核心模型
```
Route（路由）= Predicate（断言）+ Filter（过滤器）
基于 Spring WebFlux + Netty + Reactor（非阻塞异步）
```

### 工作流程
```
请求 → Gateway Handler Mapping（按 Predicate 匹配 Route）
     → Gateway Web Handler（构造过滤器链）
     → Filter Chain（Pre 过滤 → 转发 → Post 过滤）
     → Proxy Service（目标服务）

       ┌──────────┐
req → │ Predicate │ 匹配 Path/Header/Host...
       └────┬─────┘
            ↓ 匹配
       ┌──────────┐
       │ Pre Filter│ 鉴权、改请求头、限流
       └────┬─────┘
            ↓
       ┌──────────┐
       │  转发     │ Netty 异步转发到后端
       └────┬─────┘
            ↓
       ┌──────────┐
       │Post Filter│ 改响应头、日志
       └────┬─────┘
            ↓
         response
```

### Predicate 类型
Path / Header / Cookie / Query / Method / Host / After / Before / Between / Weight 等。

### 配置示例
```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-service
          uri: lb://order-service          # 负载均衡到注册中心服务
          predicates:
            - Path=/api/orders/**          # 路径匹配
            - Header=X-Store-Id, \d+       # 头匹配正则
          filters:
            - StripPrefix=2                # 转发时去掉前2段路径
            - AddRequestHeader=X-Gateway, qw
```

### 自定义全局鉴权 Filter
```java
@Component
public class AuthFilter implements GlobalFilter, Ordered {
    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String token = exchange.getRequest().getHeaders().getFirst("Authorization");
        if (!verifyToken(token)) {
            exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
            return exchange.getResponse().setComplete();  // 直接返回 401
        }
        return chain.filter(exchange);  // 放行
    }
    @Override
    public int getOrder() { return -100; }  // 优先级（越小越先）
}
```

### Filter
- **GlobalFilter**：全局，所有路由生效（鉴权、日志）。
- **GatewayFilter**：路由级别（重写路径、限流）。
- 内置：AddRequestHeader / RewritePath / RequestRateLimiter（基于 Redis + Lua）等。

### 🔴 Gateway vs Zuul vs Nginx
| | Zuul1 | Zuul2 | Gateway | Nginx |
|---|------|-------|---------|-------|
| 模型 | Servlet 同步阻塞 | Netty 异步 | **Reactor 异步** | C 事件驱动 |
| 性能 | 中 | 高 | 高（接近 Zuul2） | **最高** |
| 生态 | 老 | 少用 | **Java 生态好** | 极广 |
| 适合 | 历史 | — | **复杂业务过滤（Java）** | **入口 LB / 静态** |

### 为什么 Gateway 用 WebFlux 而非 MVC？
- 网关是 IO 密集（转发请求），非阻塞异步（Reactor + Netty）用少量线程支撑高并发。
- 用 MVC 同步阻塞，每个请求占一个线程，后端慢时线程堆积，网关先挂。

### 真实案例（茶饮 SaaS 场景

前司所有门店端请求过 Gateway，全局 AuthFilter 校验门店 token，解析出 storeId/userId 塞进请求头转发后端。配合 Sentinel 给 Gateway 做网关限流（按 IP / 按门店维度）。

### 网关能做什么
路由、鉴权、限流、熔断、日志、协议转换（HTTP↔gRPC）、灰度路由、API 聚合。

### 面试话术

「Spring Cloud Gateway 是基于 WebFlux + Netty + Reactor 的异步非阻塞网关，核心模型 Route = Predicate + Filter。请求来后 Handler Mapping 按 Predicate 匹配路由，Web Handler 构造过滤器链，Pre Filter 鉴权限流改请求头，转发后端，Post Filter 改响应。Filter 分 GlobalFilter（全局鉴权日志）和 GatewayFilter（路由级）。为什么用 WebFlux？网关是 IO 密集型，异步非阻塞用少量线程扛高并发，避免后端慢时线程堆积拖垮网关。我在前司用 Gateway 全局 Filter 校验门店 token 塞 storeId，配合 Sentinel 按门店维度限流。」

---

## 3.7 配置中心：Nacos 长轮询原理 🟡

### 为什么 / 痛点

**痛点**：多服务多环境配置散落，改个开关要改配置文件重新打包部署；密钥硬编码不安全。
**配置中心解决**：配置集中存储，支持热更新（改一处，所有服务实时生效）、多环境隔离、权限管控。

### 长轮询原理
```
1. 客户端发起长轮询请求（hold 30s）
2. 服务端：
   - 配置无变化 → 阻塞 30s 后返回
   - 配置变化 → 立即返回变更的 Data ID 列表
3. 客户端收到变更 → 按 Data ID 拉取具体配置
4. 更新本地配置 + 通知 Listener
```

`@RefreshScope` + `@Value`：Bean 用代理包装，配置变化时销毁原 Bean，下次调用重建（读到新值）。

### 配置示例
```java
@RestController
@RefreshScope                      // 配置变更时重建 Bean
public class PromoController {
    @Value("${promo.discount.max:0.8}")
    private double maxDiscount;     // Nacos 改了实时刷新

    @GetMapping("/max")
    public double max() { return maxDiscount; }
}
```

### 真实案例（茶饮 SaaS 场景

前司促销活动开关放 Nacos，运营在控制台改 `promo.flashsale.enabled=true`，所有服务 30s 内感知并开启秒杀活动，**无需重启**。曾踩坑：用 @Value 但没加 @RefreshScope，配置变了 Bean 不重建读到旧值，补上 @RefreshScope 解决。推荐用 @ConfigurationProperties（自动刷新更稳）。

### 对比 / 边界

| 维度 | Nacos | Apollo | Spring Cloud Config |
|------|-------|--------|---------------------|
| 推送 | 长轮询+UDP | HTTP 长轮询 | 需 Bus 配合 |
| 控制台 | 强 | 强 | 弱 |
| 多环境 | namespace | env | profile |
| 权限 | 中 | 强 | 弱 |

### 面试话术

「Nacos 配置中心用长轮询——客户端发请求 hold 30s，服务端配置没变就阻塞到超时返回，变了立即返回变更 Data ID，客户端再拉具体配置更新本地并通知 Listener。热更新靠 @RefreshScope，它给 Bean 包代理，配置变更时销毁原 Bean，下次调用重建读到新值。我在前司把促销活动开关放 Nacos，运营改配置秒级生效，避免重启。注意 @Value 要配 @RefreshScope 才生效，@ConfigurationProperties 自动刷新更省心。」

---

## 3.8 分布式事务：Seata 🔴

### 为什么 / 痛点

**痛点**：跨服务的多步操作（下单：扣库存服务 + 创订单服务 + 扣款服务）要么全成要么全败，但本地事务管不到别的服务的库，数据不一致。
**Seata 解决**：分布式事务框架，几个模式里 AT 模式最常用——业务无侵入，自动生成回滚 SQL。

### 三大角色
```
TM（事务管理器）：开启/提交/回滚全局事务（@GlobalTransactional 标注方）
RM（资源管理器）：每个微服务的本地事务，注册分支事务
TC（事务协调器）：Seata Server，协调全局事务状态

流程（AT 模式）：
1. TM 向 TC 开启全局事务，拿 XID
2. XID 通过 RPC 透传到各分支服务
3. 各 RM 执行业务 + 自动记录 before/after 镜像到 undo_log 表，向 TC 注册分支
4. 各分支本地事务提交（不是等全局）
5. TM 收到所有分支成功 → 通知 TC 提交；有失败 → 回滚
6. TC 异步通知各 RM：提交（删 undo_log）或回滚（用 undo_log 反向补偿）
```

### 四种模式
| 模式 | 原理 | 侵入 | 适用 |
|------|------|------|------|
| **AT** | 自动生成 undo_log 反向补偿 | 无（注解） | 大多数业务 |
| TCC | Try/Confirm/Cancel 手写 | 高 | 高性能定制 |
| SAGA | 长事务编排补偿 | 中 | 长流程 |
| XA | 强一致两阶段提交 | 低 | 强一致 |

### 真实案例（茶饮 SaaS 场景

前司下单涉及订单服务（创订单）+ 库存服务（扣库存）+ 资产服务（扣优惠券），用 Seata AT 模式 + @GlobalTransactional 保证一致。曾遇问题：某分支 undo_log 没生成（因没配数据源代理），排查发现 DataSourceProxy 没配，补上后正常。

### 对比 / 边界

| 模式 | 一致性 | 性能 | 复杂度 |
|------|--------|------|--------|
| AT | 最终一致 | 中 | 低 |
| TCC | 最终一致 | 高 | 高 |
| XA | 强一致 | 低 | 低 |
| 本地消息表 | 最终一致 | 高 | 中 |

### 面试话术

「Seata 解决微服务跨库事务。AT 模式最常用——业务无侵入，RM 自动记录数据 before/after 镜像到 undo_log，全局事务回滚时反向补偿。流程是 TM 开全局事务拿 XID，XID 经 RPC 透传，各分支执行完本地事务即提交并注册，TM 收齐结果通知 TC 提交或回滚。注意要给每个服务配 DataSourceProxy 让 Seata 接管数据源生成 undo_log。我在前司下单链路（订单+库存+资产）用 AT 模式，@GlobalTransactional 保证一致。」

---

## 3.9 服务网格 ServiceMesh 🔴

### 痛点
- 微服务 SDK（注册/熔断/链路/配置）与业务代码耦合，多语言难维护，SDK 升级成本高（推动全应用重新部署）。

### ServiceMesh（Istio）核心思想
```
应用容器 ──┐
           ├─ 共享 Network Namespace（Pod 内）
Sidecar ───┘  （Envoy，做路由/熔断/限流/遥测/mTLS）
```
- 所有流量经 Sidecar，治理能力下沉，业务无感。
- 控制面（Istiod）下发配置给所有 Sidecar。

### 演进
- SDK 微服务（侵入）→ Sidecar Mesh（无侵入）→ 无 Sidecar（Cilium/eBPF，内核层）。

### 优缺点
- 优：语言无关、统一治理、业务无感升级。
- 劣：额外一跳延迟、资源占用（每 Pod 一个 Sidecar）、运维复杂。

### 面试话术

「ServiceMesh 解决微服务 SDK 与业务耦合、多语言难维护、SDK 升级推动全量部署的痛点。Istio 把治理能力下沉到 Sidecar（Envoy），Pod 里应用容器和 Sidecar 共享网络命名空间，所有流量经 Sidecar 做路由/熔断/限流/遥测/mTLS，业务无感。控制面 Istiod 统一下发配置。代价是额外一跳延迟和每 Pod 一个 Sidecar 的资源开销。演进方向是无 Sidecar 的 eBPF 内核层方案。」

---

# 第四篇 Dubbo

## 4.1 架构 + 调用流程 🔴

### 为什么 / 痛点

**痛点**：HTTP 调用（Feign）性能不够极致——文本协议、连接开销、序列化慢。内部高频调用需要更高性能的 RPC。
**Dubbo 解决**：TCP 长连接 + 二进制序列化 + SPI 扩展，性能远超 HTTP；声明式调用像本地方法。

```
Provider ──注册──> Registry（Nacos/ZK）
   ↑                  ↓ 订阅/推送
   │←────────────── Consumer
   ↓ 调用统计
Monitor

流程：
1. Provider 启动注册到 Registry
2. Consumer 启动订阅，获取 Provider 列表（本地缓存）
3. Consumer 软负载选一个 Provider，长连接直连调用（不经注册中心）
4. 异步上报调用统计到 Monitor
```

**关键设计**：注册中心只负责"地址发现"，调用是 **Consumer → Provider 直连**（长连接），降低注册中心压力。

### 真实案例（茶饮 SaaS 场景

前司商品价格计算高频被优惠券/订单/促销调用，HTTP 性能不够，用 Dubbo + Nacos 注册，长连接复用 + Hessian2 序列化，RT 比 Feign 低 50%。

### 对比 / 边界

| 维度 | Dubbo | Feign(HTTP) |
|------|-------|-------------|
| 协议 | TCP（自定义）| HTTP |
| 序列化 | Hessian2/Protobuf | JSON |
| 性能 | 高 | 中 |
| 跨语言 | triple 协议是 | 是 |

### 面试话术

「Dubbo 是高性能 RPC 框架。Provider 启动注册到 Registry，Consumer 订阅拿 Provider 列表本地缓存，调用时软负载选实例长连接直连，不经注册中心，异步上报 Monitor。关键设计是地址发现和调用分离，注册中心压力小。我在前司商品价格计算这种高频内部调用用 Dubbo 替代 Feign，长连接复用 + Hessian2 序列化，RT 降一半。」

---

## 4.2 Dubbo SPI vs Java SPI 🔴🔴

### 为什么 / 痛点

**痛点**：Dubbo 要支持多种协议、序列化、负载均衡、注册中心，需要灵活的扩展机制。Java SPI 一次性加载所有实现、不能 IOC/AOP，不够用。
**Dubbo SPI 解决**：按 key 加载 + IOC（扩展点依赖注入）+ AOP（Wrapper 包装），是 Dubbo 灵活性的根基。

### Java SPI 问题
```java
// META-INF/services/com.xx.Driver
// 加载所有实现：
ServiceLoader<Driver> loader = ServiceLoader.load(Driver.class);
```
- 一次性加载所有实现（无法按需）。
- 无法 IOC（依赖注入）。
- 无法 AOP（无包装）。

### Dubbo SPI（@SPI + @Adaptive）
```properties
# META-INF/dubbo/org.apache.dubbo.rpc.Protocol
dubbo=org.apache.dubbo.rpc.protocol.dubbo.DubboProtocol
rest=org.apache.dubbo.rpc.protocol.rest.RestProtocol
```

```java
@SPI("dubbo")  // 默认 dubbo
public interface Protocol { ... }

// 按 key 获取
Protocol protocol = ExtensionLoader.getExtensionLoader(Protocol.class).getExtension("rest");
```

### Dubbo SPI 三大能力 🔴
1. **按 key 加载**：@SPI("default") + 配置文件。
2. **IOC**：扩展点 setter 注入其他扩展（自适应扩展）。
3. **AOP（Wrapper）**：自动包装扩展点（如 ProtocolFilterWrapper 包装 Protocol，加 Filter 链）。

### @Adaptive 自适应扩展 🔴
```java
@Adaptive
public interface Protocol {
    @Adaptive
    <T> Exporter<T> export(Invoker<T> invoker) throws RpcException;
}
```
- 运行时根据 URL 参数动态选实现：
  - 代码生成 `Protocol$Adaptive`，从 URL 取参数（如 `url.getProtocol()`），再 `getExtension(...)`。
  - 例：URL 里 protocol=dubbo → 用 DubboProtocol；protocol=rest → 用 RestProtocol。
- 意义：一套接口，根据运行时配置切换实现。

```java
// 生成的 Protocol$Adaptive（简化）
public class Protocol$Adaptive implements Protocol {
    public <T> Exporter<T> export(Invoker<T> invoker) {
        URL url = invoker.getUrl();
        String name = url.getProtocol();  // 运行时取参数
        Protocol ext = ExtensionLoader.getExtensionLoader(Protocol.class).getExtension(name);
        return ext.export(invoker);  // 动态分发
    }
}
```

### 真实案例（茶饮 SaaS 场景

前司用 Dubbo SPI 自定义 Filter 做调用链 traceId 透传和慢调用日志，注册到 `META-INF/dubbo/org.apache.dubbo.rpc.Filter`，Dubbo 自动包装到调用链。

### 对比 / 边界

| 维度 | Java SPI | Dubbo SPI | Spring FACTORY |
|------|----------|-----------|---------------|
| 按需加载 | 否 | 是 | 是 |
| IOC | 否 | 是 | 是 |
| AOP(Wrapper) | 否 | 是 | 否 |
| 自适应 | 否 | 是 | 否 |

### 面试话术

「Dubbo SPI 是 Dubbo 灵活性的根基，比 Java SPI 强三点：按 key 加载（@SPI("default") + 配置文件 key=value）、IOC（setter 注入扩展点）、AOP（Wrapper 自动包装，如 ProtocolFilterWrapper 给 Protocol 加 Filter 链）。@Adaptive 自适应扩展是精华——运行时根据 URL 参数动态选实现，编译期生成 Protocol$Adaptive，从 URL 取 protocol 参数再 getExtension。我在前司自定义 Dubbo Filter 做 traceId 透传和慢调用日志，注册到 META-INF/dubbo/...Filter 文件即生效。」

---

## 4.3 Dubbo 通信 🟡

### 原理
- 默认 **Dubbo 协议**：单一长连接 + NIO（Netty）+ Hessian2 序列化。
- 适合小数据高并发（不适合传大文件/大数据量，单连接会阻塞）。
- triple 协议：基于 HTTP/2（对标 gRPC），多路复用。
- 底层 NIO 异步，API 默认同步等待（CompletableFuture）。

```
Consumer 调用 → InvokerInvocationHandler 代理
  → ClusterInvoker（集群容错 + 负载均衡选 Provider）
  → DubboInvoker → NettyClient 发送（异步）
  → DefaultFuture + 线程挂起等待响应
Provider 端 NettyServer 收 → 业务线程池执行 → 返回
```

### 对比 / 边界

| 协议 | 传输 | 序列化 | 适用 |
|------|------|--------|------|
| dubbo | 单 TCP 长连接 | Hessian2 | 小数据高并发 |
| triple | HTTP/2 | Protobuf | 多路复用、跨语言 |
| rest | HTTP | JSON | 对外、跨语言 |

### 面试话术

「Dubbo 默认 dubbo 协议，单一 TCP 长连接 + Netty NIO + Hessian2，适合小数据高并发，不适合传大文件（单连接阻塞）。底层异步，API 默认同步等待用 DefaultFuture 挂起线程。新 triple 协议基于 HTTP/2 对标 gRPC，多路复用跨语言。」

---

## 4.4 服务治理

### 集群容错（Cluster）
- **Failover**（默认）：失败重试（换实例），适合读。
- **Failfast**：快速失败，适合非幂等写。
- **Failsafe**：失败忽略，记日志（如写审计）。
- **Failback**：失败后台重试。
- **Forking**：并行调多个，一个成功即返回。
- **Broadcast**：逐个调所有实例（刷新缓存）。

### 负载均衡（LoadBalance）
- **Random**（默认加权）：按权重随机。
- **RoundRobin**：加权轮询。
- **LeastActive**：最少活跃调用数（慢的少分配）。
- **ConsistentHash**：一致性 Hash（同参数同实例，利缓存）。

### 分组/版本
- group / version 灰度：`@DubboService(group="v2")`，Consumer 按 group 路由实现灰度。

### 隐式传参
- `RpcContext.getContext().setAttachment("traceId", id)`：链路透传，不侵入方法签名。

### 真实案例（茶饮 SaaS 场景

前司商品服务用 Random 加权（按实例性能配权重）、Failover 读、Failfast 写。traceId 用 RpcContext attachment 全链路透传。

### 面试话术

「Dubbo 服务治理包括集群容错、负载均衡、分组版本、隐式传参。容错默认 Failover 失败重试适合读，Failfast 快速失败适合非幂等写。负载均衡默认 Random 加权，LeastActive 最少活跃适合慢实例区分，ConsistentHash 同参数同实例利缓存。灰度用 group/version。链路 traceId 用 RpcContext.setAttachment 透传不侵入签名。」

---

# 第五篇 实战案例汇总

## 📌 案例 1：项目启动报循环依赖

**现象**：`BeanCurrentlyInCreationException`，A(优惠券计算)→B(促销规则)→C(商品价)→A。
**排查**：看堆栈找循环链。三个 Service 互相调，本质是职责划分不清。
**解决**：
- 重构：依赖应该单向，循环依赖往往说明**职责划分不清**。抽公共逻辑到第三方 Bean，A 和 B 都依赖它。
- 临时：@Lazy 注入（注入代理，延迟解析）。
**教训**：循环依赖本质是设计问题，能重构就别用 @Lazy 掩盖。

## 📌 案例 2：@Transactional 失效导致脏数据

**现象**：优惠券核销成功但积分发放失败，券没了积分没到（钱"消失"）。
**排查**：
```java
@Service
public class CouponService {
    public void use(Long couponId, Long userId) {
        couponMapper.markUsed(couponId);       // 核销券（独立提交）
        pointService.add(userId, 10);          // 发积分（抛异常，只回滚自己）
    }
}
```
发现 `CouponService.use()` 没有 @Transactional，而 markUsed/add 各自默认自动提交。markUsed 立即落库，add 异常只回滚自己事务。
**解决**：`use()` 加 `@Transactional(rollbackFor = Exception.class)`，两步同一事务，要么都成要么都败。
**教训**：跨方法调用要清楚事务边界，必要时提升到外层统一管理；rollbackFor 必须显式扩到 Exception。

## 📌 案例 3：Feign 调用偶尔超时

**现象**：Feign 调订单服务，偶发 `RetryableException`。
**排查**：
- Ribbon 默认 MaxAutoRetries=0，MaxAutoRetriesNextServer=1，会换实例重试。
- 但订单服务某实例 GC 抖动 → 第一次超时 → 换实例 → 正常。
- 同时业务侧没设合理超时 → 单次等很久。
**解决**：
- Feign 设 connectTimeout/readTimeout（见 3.4 配置）。
- 关闭或限制重试（避免重试放大流量）。
- 下游优化 GC（调参、控制堆、避免 Full GC）。
**教训**：超时 + 重试要联动设计，重试放大可能把下游打挂。

## 📌 案例 4：Nacos 配置不生效

**现象**：改了 Nacos 配置，但应用没刷新。
**排查**：用了 `@Value` 但没加 `@RefreshScope` → Bean 是单例，配置变了但 Bean 不重建，读到旧值。
**解决**：加 `@RefreshScope`（或用 `@ConfigurationProperties` 自动刷新）。
**教训**：@Value 必须配 @RefreshScope 才能热更新；@ConfigurationProperties 更省心，自动绑定刷新。

## 📌 案例 5：AOP this 调用事务失效

**现象**：订单创建方法 `create()` 调本类 `deductStock()`（标了 @Transactional），库存扣了但异常时没回滚。
**排查**：create() 里 `deductStock()` 等价 `this.deductStock()`，this 是目标对象不是代理，事务切面不生效。
**解决**：注入自己 `@Lazy private OrderService self;` 然后 `self.deductStock()`，或拆到独立的 StockService 类。
**教训**：同类方法互调要警惕 AOP 失效，最干净是按职责拆类。

---

# 高频追问清单（自测）

1. Bean 生命周期 9 步？AOP 代理在哪个阶段？🔴
2. 循环依赖完整流程？为什么三级不全两级？getEarlyBeanReference 做了什么？🔴🔴
3. @Transactional 7 大失效场景？传播行为 REQUIRES_NEW vs NESTED？🔴
4. @Transactional 原理？为什么同事务用同 Connection？🔴
5. Spring AOP 用 JDK 还是 CGLIB？self 调用失效原理？怎么解？🔴
6. SpringBoot 自动配置原理？@ConditionalOnMissingBean 的作用？🔴
7. 自定义 Starter 步骤？2.x 和 3.x 声明文件区别？🔴
8. refresh 12 步？内嵌 Tomcat 启动时机？🟡
9. 为什么注册中心用 AP？Nacos 怎么兼顾 AP/CP？🔴🔴
10. Sentinel vs Hystrix？Sentinel 滑动窗口？流控效果？🔴
11. Gateway vs Zuul vs Nginx？为什么 WebFlux？🔴
12. Dubbo SPI 三大能力？@Adaptive 作用？vs Java SPI？🔴🔴
13. ServiceMesh 解决什么问题？代价？🔴
14. Seata 四种模式？AT 模式流程？🔴
15. Feign 原理？集成 Sentinel？🟡
16. 你做过哪些 SpringBoot/微服务相关优化或踩坑？（结合自己项目）🔴

> 对应面试题：`面试/面试题-Spring与微服务.md`
