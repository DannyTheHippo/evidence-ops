import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Menu from './Menu';

const items = [
  { label: 'user@example.com' },
  { label: 'Admin' },
  { label: 'Member since Jan 2026' },
  { label: 'Logout', onSelect: vi.fn() },
];

describe('Menu', () => {
  it('opens on click and exposes aria-haspopup/aria-expanded on the trigger', () => {
    render(<Menu trigger="Account" items={items} />);

    const trigger = screen.getByRole('button', { name: 'Account' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
  });

  it('opens via ArrowDown on the trigger and focuses the first item', () => {
    render(<Menu trigger="Account" items={items} />);

    const trigger = screen.getByRole('button', { name: 'Account' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems[0]).toHaveFocus();
  });

  it('moves roving focus between items with ArrowDown/ArrowUp, wrapping at each end', () => {
    render(<Menu trigger="Account" items={items} />);

    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    const menuItems = screen.getAllByRole('menuitem');

    // The handler reads the current item from event.target, so each dispatch fires on the item
    // that currently has focus rather than relying on jsdom to carry it implicitly.
    fireEvent.keyDown(menuItems[0], { key: 'ArrowDown' });
    expect(menuItems[1]).toHaveFocus();

    fireEvent.keyDown(menuItems[1], { key: 'ArrowUp' });
    expect(menuItems[0]).toHaveFocus();

    fireEvent.keyDown(menuItems[0], { key: 'ArrowUp' });
    expect(menuItems[3]).toHaveFocus();

    fireEvent.keyDown(menuItems[3], { key: 'End' });
    expect(menuItems[3]).toHaveFocus();

    fireEvent.keyDown(menuItems[3], { key: 'Home' });
    expect(menuItems[0]).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<Menu trigger="Account" items={items} />);

    const trigger = screen.getByRole('button', { name: 'Account' });
    // jsdom's synthetic click does not replicate a browser's own click-focuses-the-button
    // behaviour, so focus is set explicitly here to model the keyboard flow this covers.
    trigger.focus();
    fireEvent.click(trigger);
    const menuItems = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menuItems[0], { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  // Regression: the blur handler used to test the surface rather than the whole menu. The trigger
  // is the surface's sibling, so pressing it to dismiss an open menu read as focus leaving the
  // menu — it closed, and the click that followed reopened it and pulled focus onto the first item.
  it('stays open when focus moves from the surface to its own trigger', () => {
    render(<Menu trigger="Account" items={items} />);

    const trigger = screen.getByRole('button', { name: 'Account' });
    fireEvent.click(trigger);
    const surface = screen.getByRole('menu');

    fireEvent.focusOut(surface, { relatedTarget: trigger });

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes when the trigger is pressed a second time', () => {
    render(<Menu trigger="Account" items={items} />);

    const trigger = screen.getByRole('button', { name: 'Account' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.focusOut(screen.getByRole('menu'), { relatedTarget: trigger });
    fireEvent.click(trigger);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on an outside click', () => {
    render(<Menu trigger="Account" items={items} />);

    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders an item with no onSelect as aria-disabled and does not close the menu on click', () => {
    render(<Menu trigger="Account" items={items} />);

    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    const infoItem = screen.getByRole('menuitem', { name: 'user@example.com' });
    expect(infoItem).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(infoItem);

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('calls onSelect and closes the menu when an actionable item is activated', () => {
    const onSelect = vi.fn();
    render(<Menu trigger="Account" items={[{ label: 'Logout', onSelect }]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders a danger-toned item with the danger modifier class', () => {
    render(
      <Menu
        trigger="Account"
        items={[{ label: 'Remove member', onSelect: vi.fn(), tone: 'danger' }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account' }));

    expect(screen.getByRole('menuitem', { name: 'Remove member' })).toHaveClass(
      'menu-item--danger',
    );
  });
});
