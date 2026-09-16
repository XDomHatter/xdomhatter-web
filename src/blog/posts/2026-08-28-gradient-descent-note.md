---
title: 梯度下降的一阶收敛性笔记
date: 2026-08-28
tags: [math, machine-learning]
summary: 在 L-光滑假设下推导梯度下降的收敛率，并讨论步长选择的边界条件。
---

设目标函数 $f: \mathbb{R}^d \to \mathbb{R}$ 可微且 **$L$-光滑**，即其梯度满足 Lipschitz 条件：

$$\|\nabla f(x) - \nabla f(y)\| \le L \|x - y\|, \quad \forall x, y \in \mathbb{R}^d$$

## 下降引理

由 $L$-光滑性可以直接得到所谓的下降引理（descent lemma）。对任意 $x, y$：

$$f(y) \le f(x) + \langle \nabla f(x), y - x \rangle + \frac{L}{2} \|y - x\|^2$$

取梯度下降的迭代格式 $x_{k+1} = x_k - \eta \nabla f(x_k)$，令 $y = x_{k+1}$、$x = x_k$ 代入：

$$f(x_{k+1}) \le f(x_k) - \eta \left(1 - \frac{L\eta}{2}\right) \|\nabla f(x_k)\|^2$$

### 步长约束

要让右端严格小于 $f(x_k)$，括号里的系数必须为正，于是得到步长上界：

$$0 < \eta < \frac{2}{L}$$

实践中常取 $\eta = 1/L$，此时系数为 $1/2$，形式最简洁。取 $\eta = 2/L$ 会让系数退化为 $0$，迭代停摆。

## 收敛率

在凸性假设下，对上式从 $k = 0$ 到 $T-1$ 求和并取平均，可以得到

$$\min_{0 \le k < T} \|\nabla f(x_k)\|^2 \le \frac{2L\left(f(x_0) - f^\star\right)}{T}$$

也就是说梯度值的平方以 $O(1/T)$ 的速率下降，要达到 $\|\nabla f(x)\| \le \varepsilon$ 需要 $O(1/\varepsilon^2)$ 次迭代。

> 注意这里只保证**梯度范数**收敛，不保证迭代点列本身收敛——后者需要额外的强凸性假设。

## 一段实现

```python
def gradient_descent(f, grad, x0, L, n_iter):
    x = x0
    eta = 1.0 / L
    for _ in range(n_iter):
        x = x - eta * grad(x)
    return x
```

TODO: 补一张 $\eta$ 取不同值时的收敛曲线对比。
