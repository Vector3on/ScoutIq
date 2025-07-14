# Project Omega: Behavioral Archetype Planning (Phase II)

This document outlines the strategy for creating divergent founder archetypes by modifying the reward function in `simulation/env.py`.

## 1. The "Efficiency" Founder (aka The Bootstrapper)

* **Core Behavior**: Prioritizes capital preservation and sustainable growth. Avoids burnout and high-risk, high-cost actions.
* **Reward Shaping Ideas**:
    * Add a continuous reward bonus proportional to the amount of capital in the bank.
    * Add a significant penalty for the `run_marketing_campaign` action due to its high cost.
    * Add a small penalty whenever `founder_burnout` increases.
    * Add a large penalty if the company enters bankruptcy.

## 2. The "Growth-First" Founder (aka The Gambler)

* **Core Behavior**: Aggressively pursues market traction and team growth, even at the cost of high burn and technical debt. Aims for spectacular, explosive growth.
* **Reward Shaping Ideas**:
    * Dramatically increase the reward multiplier for `delta_traction`.
    * Add a specific, large bonus for the `hire_engineer` action.
    * Remove or reduce the penalty for `founder_burnout`.
    * Provide a large reward for securing a funding round.

## 3. The "Product-Obsessed" Founder (aka The Visionary)

* **Core Behavior**: Focuses almost exclusively on product progress and managing technical debt. May neglect marketing and fundraising until the product is "perfect."
* **Reward Shaping Ideas**:
    * Dramatically increase the reward multiplier for `delta_progress`.
    * Add a large bonus for the `refactor_codebase` action.
    * Add a penalty for having high `technical_debt`.
    * Reduce the rewards associated with `market_traction` until `product_progress` is above a certain threshold (e.g., 75%).