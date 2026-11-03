/* qn_menu.h -- in-game pages for p2pquake private matches (host setup;
 * join-by-code and name entry arrive with their own work packages).
 * Driven from menu.c: m_qn_host routes draw/key here. */
#ifndef __qn_menu_h
#define __qn_menu_h

void QN_Menu_HostInit (void);
void QN_Menu_HostDraw (void);
void QN_Menu_HostKey (int key);

void QN_Menu_JoinInit (void);
void QN_Menu_JoinAdvert (const char *grouped);
void QN_Menu_JoinDraw (void);
void QN_Menu_JoinKey (int key);
void QN_Menu_JoinChar (int key);

#endif	/* __qn_menu_h */
