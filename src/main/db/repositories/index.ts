import type Database from 'better-sqlite3'
import { BlocklistRepo } from './blocklist-repo'
import { FavoritesRepo, RecentViewsRepo } from './favorites-repo'
import { MerchantsRepo } from './merchants-repo'
import { SettingsRepo } from './settings-repo'
import { ShopProductsRepo } from './shop-products-repo'
import { SyncJobsRepo } from './sync-jobs-repo'

export interface Repositories {
  merchants: MerchantsRepo
  shopProducts: ShopProductsRepo
  settings: SettingsRepo
  syncJobs: SyncJobsRepo
  favorites: FavoritesRepo
  recent: RecentViewsRepo
  blocklist: BlocklistRepo
}

export function createRepositories(db: Database.Database): Repositories {
  return {
    merchants: new MerchantsRepo(db),
    shopProducts: new ShopProductsRepo(db),
    settings: new SettingsRepo(db),
    syncJobs: new SyncJobsRepo(db),
    favorites: new FavoritesRepo(db),
    recent: new RecentViewsRepo(db),
    blocklist: new BlocklistRepo(db)
  }
}

export {
  BlocklistRepo,
  FavoritesRepo,
  MerchantsRepo,
  RecentViewsRepo,
  SettingsRepo,
  ShopProductsRepo,
  SyncJobsRepo
}
