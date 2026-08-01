# 面试题 - Spring 与微服务

> 🔴 高频 · 配套知识点：`资料/02-Spring与微服务.md`

---

## 一、Spring 核心

### Q1 🔴 IoC 和 AOP 的理解？

**IoC（控制反转）**：对象创建和依赖管理交给容器，而非自己 new。控制权反转。DI 是其实现（容器把依赖注入）。
- 好处：解耦、便于测试、便于替换。

**AOP（面向切面）**：将横切关注点（日志、事务、权限）从业务代码分离。通过动态代理在方法前后织入。
- 实现：JDK 动态代理（接口）或 CGLIB（继承）。Spring AOP 是运行时代理，Bean 间调用才生效。

---

### Q2 🔴🔴 Bean 生命周期？（必背）

```
1. 实例化（构造方法）→ 对象有了，属性空
2. 属性赋值（@Autowired/@Value 注入）
3. Aware 接口回调（BeanNameAware 等）
4. BeanPostProcessor.postProcessBeforeInitialization
5. 初始化（@PostConstruct → InitializingBean.afterPropertiesSet → init-method）
6. BeanPostProcessor.postProcessAfterInitialization  ← AOP 代理在这里生成
7. 使用
8. 销毁（@PreDestroy → DisposableBean → destroy-method）
```

**关键**：
- AOP 代理在 **第 6 步 postProcessAfterInitialization** 生成（AbstractAutoProxyCreator）。
- 循环依赖会在第 1、2 步间用三级缓存提前暴露。

---

### Q3 🔴🔴 循环依赖怎么解决？为什么三级缓存？（超高频）

**三级缓存**（DefaultSingletonBeanRegistry）：
- `singletonObjects`：一级，完整单例。
- `earlySingletonObjects`：二级，半成品（已实例化未初始化）。
- `singletonFactories`：三级，ObjectFactory（能提前生成早期引用，可能已是代理）。

**流程（A 依赖 B，B 依赖 A）**：
1. 创建 A：实例化 → A 的 ObjectFactory 入三级缓存。
2. A 注入 B：发现没 B → 创建 B：实例化 → B 的 ObjectFactory 入三级缓存。
3. B 注入 A：一级二级找不到 → 三级缓存调 ObjectFactory.getObject()（A 若被 AOP，这里提前生成代理）→ 结果入二级缓存，删三级 A → B 拿到 A 早期引用 → B 完成，入一级。
4. A 注入完成的 B → A 完成，入一级。

**为什么三级不全两级？**
- 三级缓存是 **ObjectFactory**，**延迟**决定是否提前 AOP。
- 没循环依赖时，AOP 在 postProcessAfterInitialization 正常生成。
- 有循环依赖时，通过 ObjectFactory 提前调 getEarlyBeanReference 生成代理，保证 B 注入的也是代理对象。
- 若只两级，必须在实例化后立即为所有 Bean 生成代理，破坏延迟代理设计。

**循环依赖解决不了**：构造器注入、prototype 作用域、@Async 的 Bean。

---

### Q4 🔴 @Autowired vs @Resource？

| | @Autowired | @Resource |
|---|-----------|-----------|
| 来源 | Spring | JSR250（标准） |
| 默认 | 按类型，多个看名字 | 按名字，找不到看类型 |
| 配合 | @Qualifier 指定名字 | name/type 属性 |

---

### Q5 🔴🔴 @Transactional 失效场景？（必背 7 条）

1. **方法非 public**（AOP 只代理 public）。
2. **self 调用（this.xxx）**：不走代理。→ 注入自己 `self.xxx()` 或 `AopContext.currentProxy()`。
3. **异常被 catch 吞掉**：Spring 靠抛异常感知回滚。
4. **rollbackFor 默认只回 RuntimeException/Error**：受检异常默认不回滚 → 加 `rollbackFor = Exception.class`。
5. **数据库引擎不支持事务**（MyISAM）。
6. **传播行为设了 NOT_SUPPORTED/NEVER**。
7. **Bean 没被 Spring 管理**（new 出来的）。

**传播行为 7 种**：REQUIRED（默认）/ REQUIRES_NEW / NESTED / SUPPORTS / NOT_SUPPORTED / MANDATORY / NEVER。

**原理**：AOP + TransactionInterceptor + 同事务用同 Connection（ThreadLocal 绑定）。

---

### Q6 🔴 Spring AOP self 调用失效原理？

```java
@Service
public class OrderService {
    public void a() { b(); }   // this.b() 是目标对象本身，不是代理对象
    @Transactional public void b() {}
}
```
- `a()` 调用经过代理（事务/日志生效）。
- 但 `a()` 内部 `this.b()` 是**目标对象的方法**（this 不是代理），b 的增强不生效。
- 解决：注入代理对象 `@Autowired OrderService self; self.b()`；或 `((OrderService)AopContext.currentProxy()).b()`（需 exposeProxy=true）。

---

### Q7 🟡 Spring 事务传播 REQUIRED vs REQUIRES_NEW vs NESTED？

- **REQUIRED**：有事务加入，无则新建（默认）。同事务，一起回滚。
- **REQUIRES_NEW**：总是新开事务，**挂起**当前。内外独立，互不影响。
- **NESTED**：嵌套事务，基于 **savepoint**。内层失败回滚到 savepoint，外层可继续；外层失败内层一起回滚。

---

## 二、SpringBoot

### Q8 🔴🔴 SpringBoot 自动配置原理？（必背）

`@SpringBootApplication` = `@SpringBootConfiguration` + `@EnableAutoConfiguration` + `@ComponentScan`。

**@EnableAutoConfiguration 流程**：
1. `@Import(AutoConfigurationImportSelector.class)`
2. selectImports() 加载 `META-INF/spring.factories`（2.x）/ `META-INF/spring/...AutoConfiguration.imports`（3.x）。
3. 读所有 AutoConfiguration 类名。
4. **@Conditional 过滤**：@ConditionalOnClass / @ConditionalOnMissingBean / @ConditionalOnProperty 等。
5. 满足条件的注册 Bean。

**关键**：`@ConditionalOnMissingBean` 让**用户自定义 Bean 优先**，覆盖默认配置。

---

### Q9 🟡 怎么自定义一个 Starter？

1. `xxx-spring-boot-autoconfigure`：写 `@ConfigurationProperties`（配置绑定）+ `@Configuration` + `@ConditionalOnXxx` + Bean。
2. `META-INF/spring/...AutoConfiguration.imports`（3.x）或 `spring.factories`（2.x）声明 AutoConfiguration 类。
3. `xxx-spring-boot-starter`：只做依赖打包（依赖 autoconfigure + 第三方库）。
4. 使用方引入 starter 即可。

---

### Q10 🟡 SpringBoot 启动流程？

```
SpringApplication.run()
1. new SpringApplication()：推断应用类型、加载 ApplicationContextInitializer/Listener
2. 准备环境（读 application.yml）
3. 创建 ApplicationContext（Servlet 用 AnnotationConfigServletWebServerApplicationContext）
4. prepareContext：注册主类
5. refreshContext：IoC 容器刷新（onRefresh 内嵌 Tomcat 启动）
6. afterRefresh + 广播 ApplicationReadyEvent
```
内嵌 Tomcat 在 refresh 的 `onRefresh() → createWebServer()` 启动。

---

## 三、微服务

### Q11 🔴🔴 注册中心为什么用 AP 而不是 CP？（必懂）

**注册中心核心是可用性**：服务发现不能因一致性协议阻塞。

- **AP（Eureka/Nacos AP）**：节点间复制可能短暂不一致，但服务发现始终可用。短暂的不一致（旧的下线数据）可被客户端容错（重试/熔断）。
- **CP（ZK）**：leader 选举期间**整个集群不可用**，对服务发现是灾难。

**Nacos 兼顾**：
- **临时实例**（心跳上报，AP）：适合服务发现。
- **持久实例**（CP，Raft）：适合配置、DB 元数据等需要强一致的场景。

---

### Q12 🔴 Sentinel vs Hystrix？

| | Hystrix | Sentinel |
|---|---------|----------|
| 隔离 | 线程池/信号量 | 信号量（轻量） |
| 熔断 | 异常比例 | 慢调用/异常比例/异常数 |
| 流控 | 无 | QPS/线程数 + 流控效果 |
| 自适应 | 无 | 系统自适应（BBR 思想） |
| 控制台 | 弱 | 强（动态推规则） |
| 维护 | 停更 | 活跃 |

**Sentinel 流控效果**：快速失败 / Warm Up（冷启动预热）/ 匀速排队（漏桶削峰）。

---

### Q13 🔴 Spring Cloud Gateway 原理？为什么用 WebFlux？

- 模型：Route = Predicate（断言）+ Filter（过滤器）。
- 基于 **Spring WebFlux + Netty + Reactor**，非阻塞异步。
- Filter 分 GlobalFilter 和 GatewayFilter，前置（Pre）+ 后置（Post）。

**为什么 WebFlux 而非 Spring MVC**：
- 网关是 IO 密集（转发请求），非阻塞能用少量线程扛高并发。
- MVC 是同步阻塞（一请求一线程），网关场景浪费线程。

**vs Nginx**：Nginx 性能更高（C + 事件驱动），适合入口 LB / 静态资源；Gateway 适合复杂业务过滤（鉴权、灰度、协议转换）。

---

### Q14 🔴🔴 Dubbo SPI 和 Java SPI 区别？@Adaptive？

**Java SPI 问题**：一次性加载所有实现（无法按需）、无 IOC、无 AOP。

**Dubbo SPI 优势**：
- 按 key 加载（`@SPI("default")` + `META-INF/dubbo/接口全名`）。
- **IOC**：扩展点 setter 注入其他扩展。
- **AOP（Wrapper）**：自动包装扩展（如 ProtocolFilterWrapper）。
- **@Adaptive 自适应**：运行时根据参数动态选实现（如 Protocol 按 URL.protocol）。

---

### Q15 🔴 Feign 原理？

1. `@EnableFeignClients` 扫描 `@FeignClient` 接口。
2. JDK 动态代理生成实现。
3. 方法调用 → 代理拦截 → 解析注解（url/path/param）→ 负载均衡选实例（LoadBalancer）→ HTTP 客户端发请求 → 解码响应。

**集成 Sentinel**：Feign.builder 加 SentinelInvocationHandler，每方法一个资源，可熔断降级。

---

### Q16 🟡 Nacos 配置动态刷新原理？

- **长轮询（Long Polling）**：客户端 hold 请求 30s，配置变更服务端立即返回。
- 客户端拿到变更拉新配置。
- `@RefreshScope` + `@Value`：Bean 代理，配置变化时销毁重建，读到新值。

---

### Q17 🟡 Dubbo 的负载均衡策略？

- **Random**（默认，加权随机）。
- RoundRobin（加权轮询）。
- LeastActive（最少活跃调用数，快的优先）。
- ConsistentHash（一致性哈希，相同参数路由同一提供者）。
- ShortestResponse（响应最短，2.7+）。

---

### Q18 🔴 ServiceMesh 解决什么问题？代价？

**解决**：微服务 SDK（注册/熔断/链路/配置）与业务耦合，多语言难维护，升级成本高。
- Sidecar（Envoy）下沉治理能力，业务无感、语言无关。

**代价**：
- 额外一跳延迟。
- Sidecar 资源占用。
- 运维复杂度高（Istio 学习曲线）。

**演进**：SDK 微服务 → Sidecar Mesh → 无 Sidecar（Cilium/eBPF 内核层）。

---

### Q19 🔴 你们的微服务架构？服务怎么拆的？

**答题思路（结合自己项目）**：
- 拆分依据：DDD 限界上下文 / 业务能力 / 团队边界。
- 例子：订单、商品、库存、用户、支付、营销各自独立服务，独立数据库。
- 通信：内部 Dubbo/OpenFeign 同步，跨业务异步用 MQ。
- 治理：Nacos 注册配置 + Sentinel 熔断限流 + Gateway 网关 + SkyWalking 链路。
- 数据一致性：核心用 Seata / 本地消息表，非核心最终一致。

---

### Q20 🔴 微服务有什么缺点？

1. 分布式复杂（网络不可靠、CAP）。
2. 数据一致性（分布式事务）。
3. 运维成本（部署、监控、链路）。
4. 调用延迟。
5. 测试联调难。
6. 团队协作成本。

**总结**：用"运维复杂度"换"业务扩展性"。团队小、业务简单时单体更高效。

---

## 自测重点

- [ ] Bean 生命周期 + AOP 代理生成时机
- [ ] 三级缓存 + 为什么三级
- [ ] @Transactional 7 大失效场景
- [ ] SpringBoot 自动配置原理 + 自定义 Starter
- [ ] 注册中心 AP vs CP + Nacos 兼顾
- [ ] Dubbo SPI vs Java SPI + @Adaptive
- [ ] Sentinel vs Hystrix
- [ ] Gateway 为什么 WebFlux
- [ ] Feign 原理
- [ ] 微服务优缺点 / 拆分原则
