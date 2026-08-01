# Spring 生态与微服务（源码级 · 三级缓存推导 · 自动配置 · 实战案例）

> 难度：🟢必会 🟡进阶 🔴高阶
> **目标：从"会用"讲到"读得懂源码 + 讲得清设计动机 + 踩过坑"**。
> Spring 原理题（IoC/AOP/循环依赖/事务/自动配置）是面试最高频区之一。

---

# 第一篇 Spring 核心

## 1.1 IoC / DI 深度

### IoC 的本质
- **IoC（Inversion of Control）**：对象创建和依赖管理的控制权从"对象自己"反转到"容器"。
- **DI（Dependency Injection）**：IoC 的实现方式——容器主动把依赖注入对象。
- 好处：解耦、便于测试（mock）、便于替换实现、生命周期统一管理。

### Bean 装配方式演进
```
XML 装配（古老）→ 注解装配（@Component/@Autowired）→ Java Config（@Configuration/@Bean）→ 自动装配（SpringBoot @Conditional）
```

### @Autowired vs @Resource vs @Inject 🔴

| 注解 | 来源 | 匹配顺序 |
|------|------|---------|
| @Autowired | Spring | **按类型**，多个时按字段名/参数名 + @Qualifier |
| @Resource | JSR250（标准） | **按名字**（name 属性），找不到再按类型 |
| @Inject | JSR330（标准） | 按类型，类似 @Autowired |

**@Autowired 多实现的选择规则**：
1. 候选中找 @Primary。
2. 字段名/参数名匹配 Bean 名。
3. @Qualifier 指定。
4. 都不行 → NoUniqueBeanDefinitionException。

### @Autowired 的底层：AutowiredAnnotationBeanPostProcessor 🔴
- Spring 启动时注册此 BeanPostProcessor。
- 在 `postProcessProperties` 阶段，扫描 @Autowired/@Value 字段，调用 `beanFactory.resolveDependency` 注入。

---

## 1.2 Bean 生命周期（源码级 + 完整 9 步）🔴🔴

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
```

### 关键点 🔴
- **AOP 代理在 `postProcessAfterInitialization`（第 6 步）生成**（AbstractAutoProxyCreator.postProcessAfterInitialization）。
- **循环依赖的特殊路径**：第 1 步后、第 2 步前，把 ObjectFactory 放入三级缓存，让其他 Bean 能拿到"早期引用"。
- **单例 Bean 缓存在 DefaultSingletonBeanRegistry**。

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
        // 所有 Bean 初始化前都会过这里
        return bean;
    }
    @Override
    public Object postProcessAfterInitialization(Object bean, String name) {
        return bean;
    }
}
```

---

## 1.3 循环依赖与三级缓存（推导 + 为什么三级）🔴🔴🔴（超高频中的高频）

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

### 📌 线上实战案例 1：项目启动报循环依赖

**现象**：`BeanCurrentlyInCreationException`，A→B→C→A。
**排查**：看堆栈找循环链。
**解决**：
- 重构：依赖应该单向，循环依赖往往说明**职责划分不清**。
- 临时：@Lazy 注入（注入代理，延迟解析）。
- 抽公共逻辑到第三方 Bean，A 和 B 都依赖它。

---

## 1.4 AOP 深度（代理选择 + 失效场景 + 实战）

### 核心概念
- **切面 Aspect**（@Aspect）、**切点 Pointcut**（@Pointcut，表达式）、**通知 Advice**（@Before/@After/@Around/@AfterReturning/@AfterThrowing）、**织入 Weaving**、**连接点 JoinPoint**。

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
| 性能 | 创建快，调用稍慢 | 创建慢，调用快（FastClass 索引） |
| SpringBoot 2.x | 默认 CGLIB（proxy-target-class=true） | |

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

---

## 1.5 @Transactional 深度（传播行为 + 失效 + 原理）🔴🔴

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

**为什么同事务内多个方法用同一个 Connection？** 🔴
- 事务开启时，Connection 绑定到 `TransactionSynchronizationManager` 的 ThreadLocal。
- MyBatis/JPA 通过 `DataSourceUtils.getConnection()` 获取，优先从 ThreadLocal 拿（事务内的 Connection），没有才从连接池拿。

---

# 第二篇 SpringBoot

## 2.1 自动配置原理（源码级）🔴🔴

### 入口
```java
@SpringBootApplication
// = @SpringBootConfiguration + @EnableAutoConfiguration + @ComponentScan
```

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
|---------|------|
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

## 2.2 自定义 Starter 实战 🔴

**结构**：
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

## 2.3 启动流程（refresh 详解）🟡

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

**内嵌 Tomcat 启动时机**：`onRefresh() → createWebServer()`，connector 在 `finishRefresh` 启动（接收请求）。

---

# 第三篇 Spring Cloud 微服务

## 3.1 微服务全景 + 组件对照

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

## 3.2 注册中心：Nacos vs Eureka vs ZK（CAP 详解）🔴🔴

### CAP 模型
| 注册中心 | CAP | 说明 |
|---------|-----|------|
| Eureka | AP | 去中心化复制，保证可用性 |
| Zookeeper | CP | ZAB 强一致，leader 选举期不可用 |
| Nacos | **AP + CP 双模** | 临时实例 AP（Distro 协议），持久实例 CP（Raft） |

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

## 3.3 Ribbon / LoadBalancer 负载均衡 🟡

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

## 3.4 Feign / OpenFeign 🔴

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

## 3.5 熔断降级：Sentinel vs Hystrix 🔴🔴

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

### Sentinel 流控效果 🔴
- **快速失败**：直接拒绝超出部分。
- **Warm Up（冷启动）**：开始只放少量（threshold/3），预热时长后到阈值。适合 DB 等需预热。
- **匀速排队**（漏桶）：请求匀速通过，超出排队等待。适合突发流量削峰（如 MQ 消费保护 DB）。

### 熔断规则（3 种触发）
- **慢调用比例**：RT > 阈值的请求占比 > 比例，持续时长后熔断。
- **异常比例**：异常请求占比 > 比例 → 熔断。
- **异常数**：异常数 > 阈值 → 熔断。

## 3.6 网关：Spring Cloud Gateway 🔴

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
```

### Predicate 类型
Path / Header / Cookie / Query / Method / Host / After / Before / Between / Weight 等。

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

### 网关能做什么
路由、鉴权、限流、熔断、日志、协议转换（HTTP↔gRPC）、灰度路由、API 聚合。

## 3.7 配置中心：Nacos 长轮询原理 🟡

```
1. 客户端发起长轮询请求（hold 30s）
2. 服务端：
   - 配置无变化 → 阻塞 30s 后返回
   - 配置变化 → 立即返回变更的 Data ID 列表
3. 客户端收到变更 → 按 Data ID 拉取具体配置
4. 更新本地配置 + 通知 Listener
```

`@RefreshScope` + `@Value`：Bean 用代理包装，配置变化时销毁原 Bean，下次调用重建（读到新值）。

## 3.8 服务网格 ServiceMesh 🔴

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

---

# 第四篇 Dubbo

## 4.1 架构 + 调用流程 🔴

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

## 4.2 Dubbo SPI vs Java SPI 🔴🔴

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

## 4.3 Dubbo 通信 🟡
- 默认 **Dubbo 协议**：单一长连接 + NIO（Netty）+ Hessian2 序列化。
- 适合小数据高并发（不适合传大文件/大数据量，单连接会阻塞）。
- triple 协议：基于 HTTP/2（对标 gRPC），多路复用。
- 底层 NIO 异步，API 默认同步等待（CompletableFuture）。

## 4.4 服务治理
- **集群容错**：Failover（默认，失败重试）、Failfast、Failsafe、Failback、Forking、Broadcast。
- **负载均衡**：Random（默认加权）、RoundRobin、LeastActive、ConsistentHash。
- **分组/版本**：group / version 灰度。
- **隐式传参**：`RpcContext.getContext().setAttachment("traceId", id)`。

---

# 第五篇 实战案例汇总

## 📌 案例 2：@Transactional 失效导致脏数据

**现象**：转账业务，扣款成功但加款失败，钱"消失"。
**排查**：
```java
@Service
public class TransferService {
    public void transfer(...) {
        accountService.deduct(...);   // 扣款
        accountService.add(...);      // 加款（抛异常）
    }
}
```
发现 `TransferService` 没有 @Transactional，而 deduct/add 各自有 @Transactional（独立事务）。deduct 提交后，add 异常 → 只回滚 add，钱真没了。

**解决**：`TransferService.transfer()` 加 @Transactional（REQUIRED），两步同一事务。

**教训**：跨方法调用要清楚事务边界，必要时提升到外层统一管理。

## 📌 案例 3：Feign 调用偶尔超时

**现象**：Feign 调订单服务，偶发 `RetryableException`。
**排查**：
- Ribbon 默认 MaxAutoRetries=0，MaxAutoRetriesNextServer=1，会换实例重试。
- 但订单服务某实例 GC 抖动 → 第一次超时 → 换实例 → 正常。
- 同时业务侧没设合理超时 → 单次等很久。

**解决**：
- Feign 设 connectTimeout/readTimeout。
- 关闭或限制重试（避免重试放大流量）。
- 下游优化 GC（见 Java 核心篇案例 1）。

## 📌 案例 4：Nacos 配置不生效

**现象**：改了 Nacos 配置，但应用没刷新。
**排查**：用了 `@Value` 但没加 `@RefreshScope` → Bean 是单例，配置变了但 Bean 不重建。
**解决**：加 `@RefreshScope`（或用 `@ConfigurationProperties` 自动刷新）。

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
14. Feign 原理？集成 Sentinel？🟡
15. 你做过哪些 SpringBoot/微服务相关优化或踩坑？（结合自己项目）🔴

> 对应面试题：`面试/面试题-Spring与微服务.md`
