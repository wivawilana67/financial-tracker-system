"""Jajan allocation: how much pocket money each person gets from the pool.

Port of calculateJajanAllocation_() in MonthlyGeneration.js. The Sheet works in floats; this uses
Decimal, so the only rounding is the final whole-rupiah round, which is what Math.round() does for
positive amounts (half up). A negative net is clamped to zero.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

HUNDRED = Decimal(100)


@dataclass(frozen=True)
class JajanInput:
    wiva_base: Decimal          # income in the categories that count for jajan, Wiva
    jane_base: Decimal          # same for Jane
    pool_rate: Decimal          # percent of the combined base that goes into the pool (default 10)
    wiva_rate: Decimal          # Wiva's percent of the pool (default 50)
    jane_rate: Decimal          # Jane's percent of the pool (default 50)


@dataclass(frozen=True)
class JajanResult:
    combined_base: Decimal
    gross_pool: Decimal
    wiva_net: Decimal
    jane_net: Decimal


def _round_rupiah(value: Decimal) -> Decimal:
    return value.quantize(Decimal('1'), rounding=ROUND_HALF_UP)


def allocate(inputs: JajanInput, wiva_autodeduct: Decimal, jane_autodeduct: Decimal) -> JajanResult:
    """Each person's gross share minus their autodeductions, never below zero."""
    combined = inputs.wiva_base + inputs.jane_base
    pool = combined * inputs.pool_rate / HUNDRED
    wiva_gross = pool * inputs.wiva_rate / HUNDRED
    jane_gross = pool * inputs.jane_rate / HUNDRED
    return JajanResult(
        combined_base=combined,
        gross_pool=pool,
        wiva_net=_round_rupiah(max(Decimal(0), wiva_gross - wiva_autodeduct)),
        jane_net=_round_rupiah(max(Decimal(0), jane_gross - jane_autodeduct)),
    )
