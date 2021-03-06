import { copy, IComponentOptions, IScope, IController } from 'angular';
import * as _ from 'underscore';
import template from './loadout-drawer.html';
import './loadout-drawer.scss';
import { getCharacterStatsData } from '../inventory/store/character-utils';
import { D2Categories } from '../destiny2/d2-buckets.service';
import { D1Categories } from '../destiny1/d1-buckets.service';
import { flatMap } from '../util';
import { settings } from '../settings/settings';
import { getDefinitions as getD1Definitions } from '../destiny1/d1-definitions.service';
import { getDefinitions as getD2Definitions } from '../destiny2/d2-definitions.service';
import { DestinyAccount } from '../accounts/destiny-account.service';
import { Loadout, dimLoadoutService } from './loadout.service';
import { DimStore } from '../inventory/store-types';
import { DimItem } from '../inventory/item-types';
import { router } from '../../router';

export const LoadoutDrawerComponent: IComponentOptions = {
  controller: LoadoutDrawerCtrl,
  controllerAs: 'vm',
  bindings: {
    account: '<',
    stores: '<'
  },
  template
};

function LoadoutDrawerCtrl(
  this: IController & {
    account: DestinyAccount;
    stores: DimStore[];
    loadout?: Loadout & { warnitems?: DimItem[] };
  },
  $scope: IScope,
  toaster,
  $i18next
) {
  'ngInject';
  const vm = this;

  vm.$onInit = () => {
    this.listener = router.transitionService.onExit({}, () => {
      dimLoadoutService.dialogOpen = false;
      vm.show = false;
    });
  };

  vm.$onDestroy = () => {
    this.listener();
  };

  this.$onChanges = (changes) => {
    if (changes.stores) {
      const stores = vm.stores || [];
      vm.classTypeValues = [{ label: $i18next.t('Loadouts.Any'), value: -1 }];

      /*
      Bug here was localization tried to change the label order, but users have saved their loadouts with data that was in the original order.
      These changes broke loadouts.  Next time, you have to map values between new and old values to preserve backwards compatability.
      */

      _.each(_.uniq(stores.filter((s) => !s.isVault), false, (store) => store.classType), (store) => {
        let classType = 0;

        switch (parseInt(store.classType.toString(), 10)) {
        case 0: {
          classType = 1;
          break;
        }
        case 1: {
          classType = 2;
          break;
        }
        case 2: {
          classType = 0;
          break;
        }
        }

        vm.classTypeValues.push({ label: store.className, value: classType });
      });
    }

    if (changes.account) {
      vm.show = false;
      const dimItemCategories = vm.account.destinyVersion === 2 ? D2Categories : D1Categories;
      vm.types = _.flatten(Object.values(dimItemCategories)).map((t) => t.toLowerCase());
    }
  };

  $scope.$on('dim-delete-loadout', () => {
    vm.show = false;
    dimLoadoutService.dialogOpen = false;
    vm.loadout = copy(vm.defaults);
  });

  $scope.$on('dim-edit-loadout', (_event, args: { loadout?: Loadout; showClass: boolean; equipAll: boolean }) => {
    vm.showClass = args.showClass;
    if (args.loadout) {
      vm.loadout = copy(args.loadout);
      vm.show = true;
      dimLoadoutService.dialogOpen = true;
      if (vm.loadout.classType === undefined) {
        vm.loadout.classType = -1;
      }
      vm.loadout.items = vm.loadout.items || {};

      // Filter out any vendor items and equip all if requested
      vm.loadout.warnitems = flatMap(Object.values(vm.loadout.items), (items) => items.filter((item) => !item.owner));
      fillInDefinitionsForWarnItems(vm.loadout);

      _.each(vm.loadout.items, (items, type) => {
        vm.loadout!.items[type] = items.filter((item) => item.owner);
        if (args.equipAll && vm.loadout!.items[type][0]) {
          vm.loadout!.items[type][0].equipped = true;
        }
      });
    }
  });

  $scope.$on('dim-store-item-clicked', (_event, args) => {
    vm.add(args.item, args.clickEvent);
  });

  $scope.$watchCollection('vm.loadout.items', () => {
    vm.recalculateStats();
  });

  vm.settings = settings;

  vm.show = false;
  dimLoadoutService.dialogOpen = false;
  vm.defaults = {
    classType: -1,
    items: {}
  };
  vm.loadout = copy(vm.defaults);

  vm.save = function save($event) {
    $event.preventDefault();
    if (!vm.loadout) {
      return;
    }
    const loadout = vm.loadout;
    loadout.platform = vm.account.platformLabel; // Playstation or Xbox
    loadout.destinyVersion = vm.account.destinyVersion; // D1 or D2
    dimLoadoutService
      .saveLoadout(loadout)
      .catch((e) => {
        toaster.pop('error',
                    $i18next.t('Loadouts.SaveErrorTitle'),
                    $i18next.t('Loadouts.SaveErrorDescription', { loadoutName: loadout.name, error: e.message }));
        console.error(e);
      });
    vm.cancel($event);
  };

  vm.saveAsNew = function saveAsNew($event) {
    $event.preventDefault();
    if (!vm.loadout) {
      return;
    }
    delete vm.loadout.id; // Let it be a new ID
    vm.save($event);
  };

  vm.cancel = function cancel($event) {
    $event.preventDefault();
    vm.loadout = copy(vm.defaults);
    dimLoadoutService.dialogOpen = false;
    vm.show = false;
  };

  vm.add = function add(item, $event) {
    if (!vm.loadout) {
      return;
    }
    if (item.canBeInLoadout()) {
      const clone = copy(item);

      const discriminator = clone.type.toLowerCase();
      const typeInventory = vm.loadout.items[discriminator] = (vm.loadout.items[discriminator] || []);

      clone.amount = Math.min(clone.amount, $event.shiftKey ? 5 : 1);

      const dupe = _.find(typeInventory, { hash: clone.hash, id: clone.id });

      let maxSlots = 10;
      if (item.type === 'Material') {
        maxSlots = 20;
      } else if (item.type === 'Consumable') {
        maxSlots = 19;
      }

      if (!dupe) {
        if (typeInventory.length < maxSlots) {
          clone.equipped = item.equipment && (typeInventory.length === 0);

          // Only allow one subclass per burn
          if (clone.type === 'Class') {
            const other = vm.loadout.items.class;
            if (other && other.length && other[0].dmg !== clone.dmg) {
              vm.loadout.items.class.splice(0, vm.loadout.items.class.length);
            }
            clone.equipped = true;
          }

          typeInventory.push(clone);
        } else {
          toaster.pop('warning', '', $i18next.t('Loadouts.MaxSlots', { slots: maxSlots }));
        }
      } else if (dupe && clone.maxStackSize > 1) {
        const increment = Math.min(dupe.amount + clone.amount, dupe.maxStackSize) - dupe.amount;
        dupe.amount += increment;
        // TODO: handle stack splits
      }
    } else {
      toaster.pop('warning', '', $i18next.t('Loadouts.OnlyItems'));
    }

    vm.recalculateStats();
  };

  vm.remove = function remove(item, $event) {
    if (!vm.loadout) {
      return;
    }
    const discriminator = item.type.toLowerCase();
    const typeInventory = vm.loadout.items[discriminator] = (vm.loadout.items[discriminator] || []);

    const index = typeInventory.findIndex((i) => i.hash === item.hash && i.id === item.id);

    if (index >= 0) {
      const decrement = $event.shiftKey ? 5 : 1;
      item.amount -= decrement;
      if (item.amount <= 0) {
        typeInventory.splice(index, 1);
      }
    }

    if (item.equipped && typeInventory.length > 0) {
      typeInventory[0].equipped = true;
    }

    vm.recalculateStats();
  };

  // TODO: In D2 we should probably just sub in another item w/ the same hash
  vm.removeWarnItem = (item) => {
    if (!vm.loadout) {
      return;
    }

    const index = (vm.loadout.warnitems || []).findIndex((i) => i.hash === item.hash && i.id === item.id);
    if (index >= 0) {
      vm.loadout.warnitems!.splice(index, 1);
    }
  };

  vm.equip = function equip(item) {
    if (!vm.loadout) {
      return;
    }

    if (item.equipment) {
      if ((item.type === 'Class') && (!item.equipped)) {
        item.equipped = true;
      } else if (item.equipped) {
        item.equipped = false;
      } else {
        const allItems: DimItem[] = _.flatten(Object.values(vm.loadout.items));
        if (item.equippingLabel) {
          const exotics = allItems.filter((i) => i.equippingLabel === item.equippingLabel && i.equipped);
          for (const exotic of exotics) {
            exotic.equipped = false;
          }
        }

        allItems
          .filter((i) => i.type === item.type && i.equipped)
          .forEach((i) => {
            i.equipped = false;
          });

        item.equipped = true;
      }
    }

    vm.recalculateStats(vm.loadout.items);
  };

  vm.recalculateStats = () => {
    if (vm.account.destinyVersion !== 1 || !vm.loadout || !vm.loadout.items) {
      vm.stats = null;
      return;
    }

    const items = vm.loadout.items;
    const interestingStats = new Set(['STAT_INTELLECT', 'STAT_DISCIPLINE', 'STAT_STRENGTH']);

    let numInterestingStats = 0;
    const allItems: DimItem[] = _.flatten(Object.values(items));
    const equipped = allItems.filter((i) => i.equipped);
    const stats = flatMap(equipped, (i) => i.stats!);
    const filteredStats = stats.filter((stat) => stat && interestingStats.has(stat.id.toString()));
    const combinedStats = filteredStats.reduce((stats, stat) => {
      numInterestingStats++;
      if (stats[stat.id]) {
        stats[stat.id].value += stat.value;
      } else {
        stats[stat.id] = {
          statHash: stat.statHash,
          value: stat.value
        };
      }
      return stats;
    }, {});

    // Seven types of things that contribute to these stats, times 3 stats, equals
    // a complete set of armor, ghost and artifact.
    vm.hasArmor = numInterestingStats > 0;
    vm.completeArmor = numInterestingStats === (7 * 3);

    if (_.isEmpty(combinedStats)) {
      vm.stats = null;
      return;
    }

    getD1Definitions().then((defs) => {
      vm.stats = getCharacterStatsData(defs.Stat, { stats: combinedStats });
    });
  };
}

function fillInDefinitionsForWarnItems(loadout: Loadout & { warnitems?: DimItem[] }) {
  if (!loadout.warnitems || !loadout.warnitems.length) {
    return;
  }

  if (loadout.destinyVersion === 2) {
    getD2Definitions().then((defs) => {
      for (const warnItem of loadout.warnitems!) {
        const itemDef = defs.InventoryItem.get(warnItem.hash);
        if (itemDef) {
          warnItem.icon = itemDef.displayProperties.icon;
          warnItem.name = itemDef.displayProperties.name;
        }
      }
    });
  } else {
    getD1Definitions().then((defs) => {
      for (const warnItem of loadout.warnitems!) {
        const itemDef = defs.InventoryItem.get(warnItem.hash);
        if (itemDef) {
          warnItem.icon = itemDef.icon;
          warnItem.name = itemDef.itemName;
        }
      }
    });
  }
}
