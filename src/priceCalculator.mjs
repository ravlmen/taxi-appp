export const BOARDING_FEE_CZK = 80
export const PRICE_PER_KM_CZK = 32
export const DEFAULT_PRICING = { boardingFeeCzk: BOARDING_FEE_CZK, pricePerKmCzk: PRICE_PER_KM_CZK }

export function calculateRidePrice(distanceKm, pricing = DEFAULT_PRICING) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new RangeError('Vzdálenost jízdy musí být nezáporné konečné číslo.')
  }

  return Math.round(distanceKm * pricing.pricePerKmCzk + pricing.boardingFeeCzk)
}

export function parsePricing(value) {
  const boardingFeeCzk = Number(value?.boardingFeeCzk)
  const pricePerKmCzk = Number(value?.pricePerKmCzk)
  const isValid = (number, max) => Number.isFinite(number) && number >= 0 && number <= max
  if (!isValid(boardingFeeCzk, 10000) || !isValid(pricePerKmCzk, 1000)) return null
  return {
    boardingFeeCzk: Math.round(boardingFeeCzk * 100) / 100,
    pricePerKmCzk: Math.round(pricePerKmCzk * 100) / 100,
  }
}
