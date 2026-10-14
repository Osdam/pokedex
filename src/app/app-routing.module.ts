import { NgModule } from '@angular/core';
import { PreloadAllModules, RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  {
    path: 'pokedex',
    loadComponent: () => import('./pages/pokedex/pokedex.page').then((m) => m.PokedexPage),
  },
  {
    path: 'pokemon/:id',
    loadComponent: () => import('./pages/detail/detail.page').then((m) => m.DetailPage),
  },
  {
    path: 'ar/:id',
    loadComponent: () => import('./pages/ar/ar.page').then((m) => m.ArPage),
  },
  {
    path: '',
    redirectTo: 'pokedex',
    pathMatch: 'full',
  },
];

@NgModule({
  imports: [RouterModule.forRoot(routes, { preloadingStrategy: PreloadAllModules, bindToComponentInputs: true })],
  exports: [RouterModule],
})
export class AppRoutingModule {}
