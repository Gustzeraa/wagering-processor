import { CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação (ver ARCHITECTURE.md).
 * Hoje deixa tudo passar. O desenho proposto: validar um JWT emitido por um IdP
 * (Keycloak, client credentials) e extrair o providerId do token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}